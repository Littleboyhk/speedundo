/*
 * SpeedUndo — zero-dependency static host + local speed-test target + community API.
 *   node server.js            → http://localhost:8787
 *   PORT=9000 node server.js  → custom port
 *
 * Speed-test endpoints (same contract as speed.cloudflare.com):
 *   GET  /down?bytes=N        stream N zero bytes (LAN/loopback download target)
 *   POST /up                  drain the request body, reply with received count
 *
 * Community API (crowdsourced results — no IPs or PII are ever stored):
 *   POST /api/submit          add a result {isp,asn,city,region,country,postal,
 *                             down,up,ping,jitter,loss}
 *   GET  /api/leaderboard     ?city=&postal=&window=30  ranked ISP medians
 *   GET  /api/patterns        ?isp=&city=  hour-of-day download/upload medians
 *   GET  /api/outage          ?isp=&city=  recent vs baseline health signal
 *   GET  /api/stats           public JSON API (documented in README)
 *   GET  /api/badge.svg       ?city=&isp=&metric=down  embeddable SVG badge
 *
 * Storage: data/results.json — flat array, capped, seeded with demo data on
 * first boot so every feature renders before real submissions accumulate.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8787;
const MAX_DOWN = 1e9; // 1 GB cap per request
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'results.json');
const MAX_RECORDS = 20000;
const DAY = 86400000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const ZEROS = Buffer.alloc(64 * 1024);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'cf-meta-ip, cf-meta-colo, content-length',
  };
}

/* ---- speed-test targets --------------------------------------------------- */

function handleDown(req, res, u) {
  const parsed = parseInt(u.searchParams.get('bytes') || '0', 10);
  const n = Math.max(0, Math.min(MAX_DOWN, Number.isFinite(parsed) ? parsed : 0));
  res.writeHead(200, {
    ...corsHeaders(),
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(n),
    'Cache-Control': 'no-store, no-transform',
    'cf-meta-ip': (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
    'cf-meta-colo': 'LOCAL',
  });
  if (req.method === 'HEAD' || n === 0) {
    res.end();
    return;
  }
  let sent = 0;
  const pump = () => {
    while (sent < n) {
      const remaining = n - sent;
      const chunk = remaining >= ZEROS.length ? ZEROS : ZEROS.subarray(0, remaining);
      sent += chunk.length;
      if (!res.write(chunk)) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  };
  res.on('error', () => {});
  pump();
}

function handleUp(req, res) {
  // Authoritative server-side accounting: count the bytes we actually receive
  // and the wall-clock span over which they arrive (first byte → last byte).
  // The client credits THESE confirmed bytes, never bytes merely buffered into
  // its local socket — so upload throughput can't run ahead of the receiver.
  let received = 0;
  let firstAt = 0;
  let lastAt = 0;
  req.on('data', (c) => {
    const now = Date.now();
    if (!firstAt) firstAt = now;
    lastAt = now;
    received += c.length;
  });
  req.on('end', () => {
    const ms = firstAt ? Math.max(0, lastAt - firstAt) : 0;
    // Mbps = bytes*8 (bits) / (ms/1000) (seconds) / 1e6. Null when the span is
    // too short to be meaningful (e.g. a single-chunk loopback POST).
    const mbps = ms > 0 ? Math.round(((received * 8) / (ms * 1000)) * 100) / 100 : null;
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ received, ms, mbps }));
  });
  req.on('error', () => { try { res.destroy(); } catch (_) { /* already gone */ } });
}

/* ---- data store ------------------------------------------------------------ */

let records = [];
let saveTimer = null;

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Atomic write: serialize to a temp file, then rename it over the live
    // file. rename(2) is atomic on the same filesystem, so a crash mid-write
    // can only ever leave a stale .tmp behind — the live results.json is never
    // truncated or partially written.
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFile(tmp, JSON.stringify(records), (err) => {
      if (err) { console.error('store write failed:', err.message); return; }
      fs.rename(tmp, DATA_FILE, (err2) => {
        if (err2) console.error('store commit (rename) failed:', err2.message);
      });
    });
  }, 500);
}

function loadStore() {
  let raw = null;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    // ENOENT is the normal first-boot case; anything else is worth surfacing.
    if (err.code !== 'ENOENT') console.error(`store read failed (${err.code}): ${err.message}`);
    records = [];
  }
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        records = parsed;
      } else {
        records = [];
        console.error('WARNING: store file was not a JSON array — ignoring its contents.');
      }
    } catch (err) {
      // Corrupt store (e.g. truncated by a crash during a non-atomic write in
      // an older build). Do NOT silently wipe: back the file up so the data is
      // recoverable, log loudly, and only then fall back to demo seed data.
      const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
      let backedUp = false;
      try { fs.renameSync(DATA_FILE, backup); backedUp = true; } catch (e2) {
        console.error(`store backup failed: ${e2.message}`);
      }
      console.error('*** ===============================================================');
      console.error(`*** CORRUPT STORE: could not parse ${DATA_FILE}`);
      console.error(`***   reason: ${err.message}`);
      if (backedUp) console.error(`***   unreadable file preserved at: ${backup}`);
      console.error('***   falling back to demo seed data — real data was NOT deleted.');
      console.error('*** ===============================================================');
      records = [];
    }
  }
  if (!records.length) {
    records = seedRecords();
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* exists */ }
    persist();
    console.log(`seeded community store with ${records.length} demo results`);
  } else if (records.some((r) => r.seed)) {
    // Demo store from an earlier boot: top up the "recent" seed samples when
    // they start aging out of the 2 h health window, so the leaderboard
    // doesn't decay to "No recent data". Real (non-seed) stores are never
    // touched.
    const newestSeed = Math.max(...records.filter((r) => r.seed).map((r) => r.ts));
    if (Date.now() - newestSeed > 3600000) {
      const fresh = [];
      appendRecentSeeds(fresh, Date.now(), SEED_CITIES, SEED_ISPS, seedHelpers(fresh));
      records.push(...fresh);
      persist();
      console.log(`refreshed ${fresh.length} recent demo results`);
    }
  }
}

const SEED_CITIES = [
  { city: 'Bengaluru', region: 'Karnataka', country: 'IN', postal: '560001' },
  { city: 'Mumbai', region: 'Maharashtra', country: 'IN', postal: '400001' },
  { city: 'Ambalapuzha', region: 'Kerala', country: 'IN', postal: '688561' },
];
const SEED_ISPS = [
  { isp: 'JioFiber', asn: 55836, down: 290, up: 55, ping: 12, loss: 0.2 },
  { isp: 'Airtel Xstream', asn: 24560, down: 240, up: 60, ping: 14, loss: 0.3 },
  { isp: 'ACT Fibernet', asn: 24309, down: 200, up: 100, ping: 9, loss: 0.1 },
  { isp: 'BSNL FTTH', asn: 9829, down: 70, up: 25, ping: 28, loss: 1.1 },
];

/* Shared randomization for demo records: jitter noise, the evening congestion
 * sag, and the record constructor. `out` is the array push() appends to. */
function seedHelpers(out) {
  const jitter = (v, spread) => Math.max(0.1, v * (1 - spread + Math.random() * spread * 2));
  // Evening (19–23h local) congestion; worst for BSNL.
  const sagAt = (hour, isp) => (hour >= 19 && hour <= 23
    ? (isp.startsWith('BSNL') ? 0.55 : 0.8) : (hour >= 1 && hour <= 6 ? 1.05 : 1));
  const push = (ts, c, p, hour, spread = 0.18) => {
    const sag = sagAt(hour, p.isp);
    out.push({
      ts, seed: true,
      isp: p.isp, asn: p.asn,
      city: c.city, region: c.region, country: c.country, postal: c.postal,
      down: +jitter(p.down * sag, spread).toFixed(1),
      up: +jitter(p.up * (sag < 1 ? 0.9 : 1), 0.15).toFixed(1),
      ping: +jitter(p.ping * (sag < 1 ? 1.4 : 1), 0.2).toFixed(1),
      jitter: +jitter(p.ping * 0.15, 0.5).toFixed(1),
      loss: +jitter(p.loss * (sag < 1 ? 2 : 1), 0.6).toFixed(2),
    });
  };
  return { jitter, push };
}

/* Demo seed: 30 days of plausible results for a few ISPs in a few cities, with
 * evening congestion baked in and one ISP currently degraded — so the
 * leaderboard, patterns, and outage signal all render before real submissions
 * accumulate. Wiped by deleting data/results.json. */
function seedRecords() {
  const now = Date.now();
  const cities = SEED_CITIES;
  const isps = SEED_ISPS;
  const out = [];
  const { jitter, push } = seedHelpers(out);
  // A timestamp d days ago pinned to a real local hour, so getHours() matches.
  const stamp = (d, hour, minute) => {
    const dt = new Date(now - d * DAY);
    dt.setHours(hour, minute, 0, 0);
    return dt.getTime();
  };

  for (const c of cities) {
    for (const p of isps) {
      for (let d = 30; d >= 1; d--) {
        for (const baseHour of [2, 11, 16, 21]) {
          const hour = (baseHour + Math.floor(Math.random() * 3) - 1 + 24) % 24;
          push(stamp(d, hour, Math.floor(Math.random() * 60)), c, p, hour);
        }
      }
    }
  }

  // Recent (last ~2 h) samples so the health signal is populated for everyone.
  appendRecentSeeds(out, now, cities, isps, { jitter, push });

  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/* Recent-window seed samples. Called at initial seed AND on later boots when
 * the previously seeded "recent" data has aged past the 2 h health window —
 * otherwise a demo store older than 2 h shows every ISP as "No recent data". */
function appendRecentSeeds(out, now, cities, isps, { jitter, push }) {
  for (const c of cities) {
    for (const p of isps) {
      const degraded = p.isp.startsWith('BSNL') && c.city === 'Bengaluru';
      for (let i = 0; i < 5; i++) {
        // Cluster in the last 30 min so they stay inside the 2 h health
        // window for well over an hour between top-ups.
        const ts = now - Math.round(Math.random() * 30 * 60000);
        if (degraded) {
          out.push({
            ts, seed: true, isp: p.isp, asn: p.asn,
            city: c.city, region: c.region, country: c.country, postal: c.postal,
            down: +jitter(24, 0.25).toFixed(1), up: +jitter(8, 0.25).toFixed(1),
            ping: +jitter(95, 0.3).toFixed(1), jitter: +jitter(22, 0.4).toFixed(1),
            loss: +jitter(6, 0.5).toFixed(2),
          });
        } else {
          // Neutral hour (no evening sag) + low spread: these few samples set
          // the demo's "current" level, and noise or sag here would randomly
          // trip the -15% "slower than usual" threshold.
          push(ts, c, p, 12, 0.05);
        }
      }
    }
  }
}

/* ---- aggregation ----------------------------------------------------------- */

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const norm = (s) => String(s || '').trim().toLowerCase();

function filterRecords({ city, postal, isp, sinceMs }) {
  const c = norm(city);
  const p = norm(postal);
  const i = norm(isp);
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  return records.filter((r) =>
    (!c || norm(r.city) === c)
    && (!p || norm(r.postal) === p)
    && (!i || norm(r.isp) === i)
    && r.ts >= cutoff);
}

/* Health signal: recent (2 h) download median vs baseline (window) median. */
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

// Most frequent non-empty value of pick(r) across a group (ties → first seen).
// Used to choose one stable display name / ASN for an operator that reports
// several name variants.
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

function leaderboard({ city, postal, windowDays }) {
  const rs = filterRecords({ city, postal, sinceMs: windowDays * DAY });
  const groups = new Map();
  for (const r of rs) {
    // Group by ASN first: one operator often reports several display-name
    // variants (e.g. "BSNL FTTH" vs "Bharat Sanchar Nigam LTD") that must not
    // split into separate rows. Fall back to the normalized name only when the
    // ASN is missing.
    const key = r.asn != null ? `asn:${r.asn}` : `name:${norm(r.isp)}`;
    if (key === 'name:') continue; // neither ASN nor name → unusable
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const isps = [...groups.values()].map((list) => {
    const h = healthFor(list);
    return {
      // Display name = the most common variant in the group; never a split key.
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
  return { scope: { city: city || null, postal: postal || null, windowDays, samples: rs.length }, isps };
}

function patterns({ isp, city }) {
  const rs = filterRecords({ isp, city, sinceMs: 30 * DAY });
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
  return { scope: { isp: isp || null, city: city || null, windowDays: 30, samples: rs.length }, hours };
}

/* ---- API handlers ----------------------------------------------------------- */

function sendJson(res, code, obj) {
  res.writeHead(code, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

const cleanStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null) || null;
const cleanNum = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

function handleSubmit(req, res) {
  let body = '';
  let overflow = false;
  req.on('data', (c) => {
    body += c;
    if (body.length > 10000) { overflow = true; req.destroy(); }
  });
  req.on('end', () => {
    if (overflow) return;
    let j;
    try { j = JSON.parse(body); } catch (_) {
      return sendJson(res, 400, { ok: false, error: 'Body must be JSON.' });
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
      return sendJson(res, 400, { ok: false, error: 'isp, city and down are required.' });
    }
    records.push(rec);
    if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
    persist();
    sendJson(res, 200, { ok: true, stored: true });
  });
  req.on('error', () => {});
}

function badgeSvg(u) {
  const city = u.searchParams.get('city') || '';
  const isp = u.searchParams.get('isp') || '';
  const metric = u.searchParams.get('metric') === 'up' ? 'up' : 'down';
  const rs = filterRecords({ city, isp, sinceMs: 30 * DAY });
  const value = median(rs.map((r) => r[metric]));
  const h = healthFor(rs);
  const label = (isp || city || 'internet').slice(0, 24);
  const arrow = metric === 'down' ? '↓' : '↑';
  const text = value == null ? 'no data' : `${round1(value)} Mbps ${arrow}`;
  const color = { good: '#0CA30C', warning: '#B08000', serious: '#C25E2E', critical: '#D03B3B', unknown: '#666F7D' }[h.status];
  const lw = 60 + label.length * 7.2; // extra base width for the "speedundo · " prefix
  const vw = 24 + text.length * 7.2;
  const w = Math.round(lw + vw);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24" role="img" aria-label="${label}: ${text}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-opacity=".08"/><stop offset="1" stop-opacity=".18" stop-color="#000"/></linearGradient>
  <rect rx="4" width="${w}" height="24" fill="#0D1420"/>
  <rect rx="4" x="${Math.round(lw)}" width="${Math.round(vw)}" height="24" fill="${color}"/>
  <rect rx="4" width="${w}" height="24" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="Consolas,Menlo,monospace" font-size="11">
    <text x="${Math.round(lw / 2)}" y="16" fill="#EDF3FC">speedundo · ${label}</text>
    <text x="${Math.round(lw + vw / 2)}" y="16" font-weight="bold">${text}</text>
  </g>
</svg>`;
}

function handleApi(req, res, u) {
  const q = u.searchParams;
  switch (u.pathname) {
    case '/api/submit':
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only.' });
      return handleSubmit(req, res);
    case '/api/leaderboard':
      return sendJson(res, 200, leaderboard({
        city: q.get('city'), postal: q.get('postal'),
        windowDays: Math.min(90, Math.max(1, Number(q.get('window')) || 30)),
      }));
    case '/api/patterns':
      return sendJson(res, 200, patterns({ isp: q.get('isp'), city: q.get('city') }));
    case '/api/outage': {
      const rs = filterRecords({ isp: q.get('isp'), city: q.get('city'), sinceMs: 30 * DAY });
      return sendJson(res, 200, {
        scope: { isp: q.get('isp') || null, city: q.get('city') || null },
        ...healthFor(rs),
      });
    }
    case '/api/stats': {
      const scope = { isp: q.get('isp'), city: q.get('city'), postal: q.get('postal') };
      const rs = filterRecords({ ...scope, sinceMs: 30 * DAY });
      return sendJson(res, 200, {
        api: 'speedundo/1', windowDays: 30, samples: rs.length,
        scope: { isp: scope.isp || null, city: scope.city || null, postal: scope.postal || null },
        median: {
          down: round1(median(rs.map((r) => r.down))),
          up: round1(median(rs.map((r) => r.up))),
          ping: round1(median(rs.map((r) => r.ping))),
          jitter: round1(median(rs.map((r) => r.jitter))),
          loss: round1(median(rs.map((r) => r.loss).filter((v) => v != null))),
        },
        health: healthFor(rs),
      });
    }
    case '/api/badge.svg': {
      res.writeHead(200, {
        ...corsHeaders(),
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(badgeSvg(u));
    }
    default:
      return sendJson(res, 404, { ok: false, error: 'Unknown API path.' });
  }
}

/* ---- static ------------------------------------------------------------------ */

function handleStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }
  if (rel === '/') rel = '/index.html';
  const abs = path.normalize(path.join(ROOT, rel));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  if (abs.startsWith(DATA_DIR)) { // the community store is not a public file
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ---- server ------------------------------------------------------------------- */

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (u.pathname === '/down') return handleDown(req, res, u);
  if (u.pathname === '/up' && req.method === 'POST') return handleUp(req, res);
  if (u.pathname.startsWith('/api/')) return handleApi(req, res, u);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }
  handleStatic(res, u.pathname);
});

loadStore();
server.listen(PORT, () => {
  console.log(`SpeedUndo → http://localhost:${PORT}`);
});
