/*
 * SpeedUndo — Cloudflare Worker.
 *
 * Replaces the Node http server (../server.js). Responsibilities:
 *   - speed-test targets:  GET /down?bytes=N   POST /up
 *   - community API:       /api/submit, /leaderboard, /patterns, /outage,
 *                          /stats, /badge.svg
 *   - static assets:       served by the [assets] binding (env.ASSETS), NOT by
 *                          this script — anything that isn't a route above
 *                          falls through to it.
 *
 * Bindings (see wrangler.jsonc, added in a later stage):
 *   env.DB      D1Database  — the `results` table (migrations/0001,0002)
 *   env.ASSETS  Fetcher     — static asset server (index.html, css/, js/, ...)
 *
 * NOTE: request-scoped state stays in locals passed through the call chain.
 * Nothing request-specific is stored at module scope (Workers reuses the
 * isolate across requests — module globals would leak between users).
 */

const MAX_DOWN = 1e9;        // 1 GB cap per /down request (from server.js)
const MAX_RECORDS = 20000;   // community store cap (from server.js)
const DAY = 86400000;

/* ---- CORS (verbatim contract from server.js) ------------------------------ */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'cf-meta-ip, cf-meta-colo, content-length',
  };
}

function json(obj, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/* ---- speed-test targets --------------------------------------------------- */

// A single shared 64 KiB zero-filled buffer, reused for every chunk of every
// /down response. Safe because it is never mutated — enqueuing the same
// immutable view many times just streams zeros. Avoids allocating (and GC-ing)
// thousands of buffers for a multi-hundred-MB download.
const ZERO_CHUNK = new Uint8Array(65536);

// GET /down?bytes=N — stream exactly N zero bytes as application/octet-stream.
// Ported from server.js handleDown: N is clamped to [0, MAX_DOWN]; HEAD and
// N === 0 return headers only. On the edge we can report the REAL colo and the
// client's own IP (server.js hardcoded 'LOCAL' because it ran on loopback).
function handleDown(request, url) {
  const parsed = parseInt(url.searchParams.get('bytes') || '0', 10);
  const n = Math.max(0, Math.min(MAX_DOWN, Number.isFinite(parsed) ? parsed : 0));

  const headers = {
    ...corsHeaders(),
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(n),
    'Cache-Control': 'no-store, no-transform',
    'cf-meta-ip': (request.headers.get('CF-Connecting-IP') || '').replace(/^::ffff:/, ''),
    'cf-meta-colo': (request.cf && request.cf.colo) || 'EDGE',
  };

  if (request.method === 'HEAD' || n === 0) {
    return new Response(null, { status: 200, headers });
  }

  let sent = 0;
  const body = new ReadableStream(
    {
      // pull() is re-invoked by the runtime as the client drains, so buffered
      // memory stays bounded by the queuing strategy's highWaterMark (512 KiB
      // below) no matter how large N is — the 1 GB cap never sits in memory.
      pull(controller) {
        while (sent < n) {
          const remaining = n - sent;
          const chunk = remaining >= ZERO_CHUNK.length
            ? ZERO_CHUNK
            : ZERO_CHUNK.subarray(0, remaining);
          controller.enqueue(chunk);
          sent += chunk.byteLength;
          // Yield once the consumer's buffer is full; resumes on next pull().
          if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        }
        controller.close();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 512 * 1024 }),
  );

  return new Response(body, { status: 200, headers });
}

// POST /up — drain the request body and reply with the authoritative count of
// bytes actually received. `received` is the ONLY trusted field: the client
// credits it (not bytes merely buffered into its local socket), so upload
// throughput can't run ahead of the receiver. The body is streamed through a
// reader and each chunk discarded immediately — O(1) memory regardless of size.
//
// NO server-side timing/mbps is returned. On the Cloudflare edge the request
// body is buffered before the Worker runs, so a first-byte→last-byte span here
// measures edge→Worker delivery (observed ~176 ms for an 8 MB upload that took
// the client 3.76 s), NOT the real upload rate. That figure was meaningless and
// is intentionally dropped; the client measures upload throughput itself from
// these confirmed byte counts over its own wall clock.
async function handleUp(request) {
  let received = 0;

  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        // value is dropped here — no accumulation, constant memory.
      }
    } finally {
      reader.releaseLock();
    }
  }

  // edgeBuffered flags that any server-side timing would be unreliable here, so
  // consumers know `received` is the only meaningful field.
  return json({ received, edgeBuffered: true });
}

/* ---- data store ----------------------------------------------------------- */

const SELECT_COLS = 'ts, isp, asn, city, region, country, postal, down, up, ping, jitter, loss, is_demo';

// Mirrors server.js filterRecords(): SQL does the index-backed filtering
// (city/postal/isp equality + ts window); JS does the median()/mostCommon()/
// ASN grouping. is_demo is selected so callers can partition.
//
// The WHERE clause is built from ONLY the predicates that are present. This is
// deliberate: the tempting `(?N IS NULL OR col = ?N)` one-statement idiom
// defeats the composite indexes — SQLite can't know at plan time whether the
// bound param is null, so it falls back to the plain ts index and filters the
// column in memory (verified via EXPLAIN QUERY PLAN). Emitting `city = ?`
// only when a city is given lets the planner use idx_results_city_ts
// (city=? AND ts>?) — a tight index seek, which is the leaderboard hot path.
// Columns collate NOCASE, so equality is case-insensitive without LOWER().
async function filterRecords(env, { city, postal, isp, sinceMs }) {
  const clean = (s) => (s == null || s === '' ? null : String(s).trim());
  const conds = [];
  const binds = [];
  const c = clean(city);
  const p = clean(postal);
  const i = clean(isp);
  if (c) { conds.push('city = ?'); binds.push(c); }
  if (p) { conds.push('postal = ?'); binds.push(p); }
  if (i) { conds.push('isp = ?'); binds.push(i); }
  conds.push('ts >= ?');
  binds.push(sinceMs ? Date.now() - sinceMs : 0);
  const { results } = await env.DB
    .prepare(`SELECT ${SELECT_COLS} FROM results WHERE ${conds.join(' AND ')}`)
    .bind(...binds)
    .all();
  return results || [];
}

// Demo/real separation policy (never silently blend the two):
//   - If the scope has ANY real rows (is_demo = 0), aggregate over REAL rows
//     only and report demo:false. Demo rows are dropped, not mixed in.
//   - If the scope has NO real rows yet, aggregate over demo rows and report
//     demo:true so the client labels the panel as sample data.
// Returns { rows, demo }.
function splitDemo(rows) {
  const real = rows.filter((r) => !r.is_demo);
  if (real.length) return { rows: real, demo: false };
  return { rows, demo: true };
}

// INSERT (is_demo = 0) + cap-delete in one env.DB.batch(). D1 runs a batch as a
// single implicit transaction, so the 20k cap is enforced atomically with the
// write — no partial-write window. This is the D1 equivalent of server.js's
// atomic tmp-file rename, but with real ACID semantics.
async function insertRecord(env, rec) {
  const insert = env.DB
    .prepare(
      `INSERT INTO results
         (ts, isp, asn, city, region, country, postal, down, up, ping, jitter, loss, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(rec.ts, rec.isp, rec.asn, rec.city, rec.region, rec.country,
      rec.postal, rec.down, rec.up, rec.ping, rec.jitter, rec.loss);
  // Keep the newest MAX_RECORDS rows; delete everything older (LIMIT -1 = no
  // limit, OFFSET skips the rows we keep). Mirrors records.slice(-MAX_RECORDS).
  const cap = env.DB
    .prepare('DELETE FROM results WHERE id IN (SELECT id FROM results ORDER BY ts DESC LIMIT -1 OFFSET ?)')
    .bind(MAX_RECORDS);
  await env.DB.batch([insert, cap]);
}

/* ---- aggregation (ported verbatim from server.js) ------------------------- */

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const norm = (s) => String(s || '').trim().toLowerCase();

// Health signal: recent (2 h) download median vs baseline (window) median.
function healthFor(rs) {
  const baseline = median(rs.map((r) => r.down));
  const recent = rs.filter((r) => r.ts >= Date.now() - 2 * 3600000);
  const recentMedian = median(recent.map((r) => r.down));
  if (baseline == null || recentMedian == null || recent.length < 3) {
    return {
      status: 'unknown', label: 'No recent data', deltaPct: null,
      baseline: round1(baseline), recent: round1(recentMedian),
      recentSamples: recent.length,
    };
  }
  const deltaPct = Math.round(((recentMedian - baseline) / baseline) * 100);
  let status = 'good';
  let label = 'Healthy';
  if (deltaPct < -70) { status = 'critical'; label = 'Possible outage'; }
  else if (deltaPct < -40) { status = 'serious'; label = 'Degraded'; }
  else if (deltaPct < -15) { status = 'warning'; label = 'Slower than usual'; }
  return {
    status, label, deltaPct,
    baseline: round1(baseline), recent: round1(recentMedian),
    recentSamples: recent.length,
  };
}

// Most frequent non-empty value across a group (ties → first seen).
function mostCommon(list, pick) {
  const counts = new Map();
  let best = null;
  let bestN = 0;
  for (const r of list) {
    const v = pick(r);
    if (v == null || v === '') continue;
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

// Leaderboard — groups by ASN first (the critical audit fix): one operator can
// report several display-name variants that must not split into separate rows.
function buildLeaderboard(rs) {
  const groups = new Map();
  for (const r of rs) {
    const key = r.asn != null ? `asn:${r.asn}` : `name:${norm(r.isp)}`;
    if (key === 'name:') continue; // neither ASN nor name → unusable
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const isps = [...groups.values()].map((list) => {
    const h = healthFor(list);
    return {
      isp: mostCommon(list, (r) => r.isp) || list[list.length - 1].isp,
      asn: mostCommon(list, (r) => r.asn) || null,
      samples: list.length,
      down: round1(median(list.map((r) => r.down))),
      up: round1(median(list.map((r) => r.up))),
      ping: round1(median(list.map((r) => r.ping))),
      loss: round1(median(list.map((r) => (r.loss == null ? null : r.loss)).filter((v) => v != null))),
      health: { status: h.status, label: h.label, deltaPct: h.deltaPct },
    };
  }).filter((e) => e.samples >= 1 && e.down != null);
  isps.sort((a, b) => b.down - a.down);
  return isps;
}

function buildPatterns(rs) {
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const bucket = rs.filter((r) => new Date(r.ts).getHours() === h);
    hours.push({
      hour: h,
      down: round1(median(bucket.map((r) => r.down))),
      up: round1(median(bucket.map((r) => r.up))),
      samples: bucket.length,
    });
  }
  return hours;
}

/* ---- input validation (ported from server.js) ---------------------------- */

const cleanStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null) || null;
const cleanNum = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/* ---- API handlers --------------------------------------------------------- */

async function handleSubmit(request, env) {
  // Reject oversized bodies before buffering (server.js capped at 10 KB).
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > 10000) {
    return json({ ok: false, error: 'Body too large.' }, { status: 413 });
  }
  const body = await request.text();
  if (body.length > 10000) {
    return json({ ok: false, error: 'Body too large.' }, { status: 413 });
  }
  let j;
  try { j = JSON.parse(body); } catch (_) {
    return json({ ok: false, error: 'Body must be JSON.' }, { status: 400 });
  }
  const rec = {
    ts: Date.now(),
    isp: cleanStr(j.isp, 80),
    asn: cleanNum(j.asn, 1, 4294967295),
    city: cleanStr(j.city, 80),
    region: cleanStr(j.region, 80),
    country: cleanStr(j.country, 2),
    postal: cleanStr(j.postal, 12),
    down: cleanNum(j.down, 0.01, 100000),
    up: cleanNum(j.up, 0, 100000),
    ping: cleanNum(j.ping, 0, 10000),
    jitter: cleanNum(j.jitter, 0, 10000),
    loss: cleanNum(j.loss, 0, 100),
  };
  if (!rec.isp || !rec.city || rec.down == null) {
    return json({ ok: false, error: 'isp, city and down are required.' }, { status: 400 });
  }
  await insertRecord(env, rec);
  return json({ ok: true, stored: true });
}

async function handleLeaderboard(env, q) {
  const windowDays = Math.min(90, Math.max(1, Number(q.get('window')) || 30));
  const city = q.get('city');
  const postal = q.get('postal');
  const all = await filterRecords(env, { city, postal, sinceMs: windowDays * DAY });
  const { rows, demo } = splitDemo(all);
  return json({
    scope: { city: city || null, postal: postal || null, windowDays, samples: rows.length },
    isps: buildLeaderboard(rows),
    demo,
  });
}

async function handlePatterns(env, q) {
  const isp = q.get('isp');
  const city = q.get('city');
  const all = await filterRecords(env, { isp, city, sinceMs: 30 * DAY });
  const { rows, demo } = splitDemo(all);
  return json({
    scope: { isp: isp || null, city: city || null, windowDays: 30, samples: rows.length },
    hours: buildPatterns(rows),
    demo,
  });
}

async function handleOutage(env, q) {
  const isp = q.get('isp');
  const city = q.get('city');
  const all = await filterRecords(env, { isp, city, sinceMs: 30 * DAY });
  const { rows, demo } = splitDemo(all);
  return json({
    scope: { isp: isp || null, city: city || null },
    ...healthFor(rows),
    demo,
  });
}

async function handleStats(env, q) {
  const scope = { isp: q.get('isp'), city: q.get('city'), postal: q.get('postal') };
  const all = await filterRecords(env, { ...scope, sinceMs: 30 * DAY });
  const { rows, demo } = splitDemo(all);
  return json({
    api: 'speedundo/1', windowDays: 30, samples: rows.length,
    scope: { isp: scope.isp || null, city: scope.city || null, postal: scope.postal || null },
    median: {
      down: round1(median(rows.map((r) => r.down))),
      up: round1(median(rows.map((r) => r.up))),
      ping: round1(median(rows.map((r) => r.ping))),
      jitter: round1(median(rows.map((r) => r.jitter))),
      loss: round1(median(rows.map((r) => r.loss).filter((v) => v != null))),
    },
    health: healthFor(rows),
    demo,
  });
}

async function handleBadge(env, q) {
  const city = q.get('city') || '';
  const isp = q.get('isp') || '';
  const metric = q.get('metric') === 'up' ? 'up' : 'down';
  const all = await filterRecords(env, { city, isp, sinceMs: 30 * DAY });
  const { rows, demo } = splitDemo(all);
  const value = median(rows.map((r) => r[metric]));
  const h = healthFor(rows);
  const label = (isp || city || 'internet').slice(0, 24);
  const arrow = metric === 'down' ? '↓' : '↑';
  // Never present demo numbers as real on an externally-embedded badge.
  const suffix = demo ? ' (sample)' : '';
  const text = value == null ? 'no data' : `${round1(value)} Mbps ${arrow}${suffix}`;
  const color = { good: '#0CA30C', warning: '#B08000', serious: '#C25E2E', critical: '#D03B3B', unknown: '#666F7D' }[h.status];
  const lw = 60 + label.length * 7.2;
  const vw = 24 + text.length * 7.2;
  const w = Math.round(lw + vw);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24" role="img" aria-label="${label}: ${text}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-opacity=".08"/><stop offset="1" stop-opacity=".18" stop-color="#000"/></linearGradient>
  <rect rx="4" width="${w}" height="24" fill="#0D1420"/>
  <rect rx="4" x="${Math.round(lw)}" width="${Math.round(vw)}" height="24" fill="${color}"/>
  <rect rx="4" width="${w}" height="24" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="Consolas,Menlo,monospace" font-size="11">
    <text x="${Math.round(lw / 2)}" y="16" fill="#EDF3FC">speedundo · ${label}</text>
    <text x="${Math.round(lw + vw / 2)}" y="16" font-weight="bold">${text}</text>
  </g>
</svg>`;
  return new Response(svg, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// /api/* dispatch — mirrors the switch in server.js handleApi().
async function handleApi(request, env, url) {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/submit':
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'POST only.' }, { status: 405 });
      }
      return handleSubmit(request, env);
    case '/api/leaderboard':
      return handleLeaderboard(env, q);
    case '/api/patterns':
      return handlePatterns(env, q);
    case '/api/outage':
      return handleOutage(env, q);
    case '/api/stats':
      return handleStats(env, q);
    case '/api/badge.svg':
      return handleBadge(env, q);
    default:
      return json({ ok: false, error: 'Unknown API path.' }, { status: 404 });
  }
}

/* ---- entrypoint ----------------------------------------------------------- */

export default {
  /**
   * @param {Request} request
   * @param {{ DB: D1Database, ASSETS: Fetcher }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight — every route shares the same policy.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Speed-test targets.
    if (url.pathname === '/down') return handleDown(request, url);
    if (url.pathname === '/up' && request.method === 'POST') return handleUp(request);

    // Community API.
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);

    // Everything else is a static asset. The [assets] binding handles path
    // normalization, content types, 404s, and range requests — so the
    // hand-rolled handleStatic()/MIME map/path-traversal guard from server.js
    // are no longer needed (the platform does it, and can't be tricked into
    // serving data/ because the D1 store isn't a file here).
    return env.ASSETS.fetch(request);
  },
};
