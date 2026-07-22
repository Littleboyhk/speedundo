/*
 * Generates migrations/0002_seed_demo_data.sql — a REPRODUCIBLE demo seed.
 *
 *   node scripts/gen-seed.js
 *
 * Why a generator instead of hand-written SQL or a manual `d1 execute`:
 *   - Deterministic: a fixed-seed PRNG (mulberry32) means every run emits the
 *     exact same numeric values, so the committed .sql file is regenerable and
 *     diffable. No Math.random() nondeterminism.
 *   - Fresh at apply time: timestamps are SQL expressions computed relative to
 *     when the migration runs (unixepoch('now', ...)), not frozen literals. A
 *     deploy today gets a 30-day demo window ending today — mirroring how
 *     server.js seeded relative to boot time.
 *
 * Faithful port of seedRecords()/appendRecentSeeds() from server.js: 30 days
 * of plausible history for a few ISPs in a few cities, with evening congestion
 * baked in and BSNL-in-Bengaluru currently degraded, so the leaderboard,
 * patterns and outage signal all render before real data arrives.
 *
 * All rows are written with is_demo = 1. Real submissions insert is_demo = 0.
 * Aggregation never blends the two (see src/worker.js).
 *
 * NOTE ON HOUR-OF-DAY: /api/patterns buckets by new Date(ts).getHours(), which
 * on Workers is UTC. Historical timestamps are pinned to UTC hours via
 * unixepoch(date('now','-N days')) + hour*3600, so the congestion curve lands
 * on the intended hours. (server.js said "server local time"; on the edge that
 * is UTC — documented, not a behaviour change that matters for a demo.)
 *
 * NOTE ON STALENESS: like server.js, the historical window ages after apply.
 * server.js topped up the "recent" (2 h health window) samples on each boot;
 * the Workers equivalent is a Cron Trigger re-running the recent-seed insert,
 * deferred to the wrangler/cron stage. This file seeds the initial state only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// --- deterministic PRNG (mulberry32) ----------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(1234567); // fixed seed → identical output every run

// --- seed inputs (verbatim from server.js) ----------------------------------
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

// --- value math (verbatim from server.js seedHelpers) ------------------------
const jitter = (v, spread) => Math.max(0.1, v * (1 - spread + rng() * spread * 2));
const sagAt = (hour, isp) => (hour >= 19 && hour <= 23
  ? (isp.startsWith('BSNL') ? 0.55 : 0.8) : (hour >= 1 && hour <= 6 ? 1.05 : 1));

function metrics(c, p, hour, spread = 0.18) {
  const sag = sagAt(hour, p.isp);
  return {
    isp: p.isp, asn: p.asn,
    city: c.city, region: c.region, country: c.country, postal: c.postal,
    down: +jitter(p.down * sag, spread).toFixed(1),
    up: +jitter(p.up * (sag < 1 ? 0.9 : 1), 0.15).toFixed(1),
    ping: +jitter(p.ping * (sag < 1 ? 1.4 : 1), 0.2).toFixed(1),
    jitter: +jitter(p.ping * 0.15, 0.5).toFixed(1),
    loss: +jitter(p.loss * (sag < 1 ? 2 : 1), 0.6).toFixed(2),
  };
}

// --- row collection ----------------------------------------------------------
const rows = [];

// Historical: 30 days back, four base hours/day, jittered ±1 h (server.js loop).
for (const c of SEED_CITIES) {
  for (const p of SEED_ISPS) {
    for (let d = 30; d >= 1; d--) {
      for (const baseHour of [2, 11, 16, 21]) {
        const hour = (baseHour + Math.floor(rng() * 3) - 1 + 24) % 24;
        const minute = Math.floor(rng() * 60);
        const tsSql = `(unixepoch(date('now','-${d} days')) + ${hour * 3600 + minute * 60}) * 1000`;
        rows.push({ tsSql, ...metrics(c, p, hour) });
      }
    }
  }
}

// Recent (last ~30 min) samples so the 2 h health window is populated;
// BSNL-in-Bengaluru is the degraded operator. Verbatim logic.
for (const c of SEED_CITIES) {
  for (const p of SEED_ISPS) {
    const degraded = p.isp.startsWith('BSNL') && c.city === 'Bengaluru';
    for (let i = 0; i < 5; i++) {
      const secAgo = Math.round(rng() * 30 * 60);
      const tsSql = `(unixepoch('now') - ${secAgo}) * 1000`;
      if (degraded) {
        rows.push({
          tsSql, isp: p.isp, asn: p.asn,
          city: c.city, region: c.region, country: c.country, postal: c.postal,
          down: +jitter(24, 0.25).toFixed(1), up: +jitter(8, 0.25).toFixed(1),
          ping: +jitter(95, 0.3).toFixed(1), jitter: +jitter(22, 0.4).toFixed(1),
          loss: +jitter(6, 0.5).toFixed(2),
        });
      } else {
        rows.push({ tsSql, ...metrics(c, p, 12, 0.05) });
      }
    }
  }
}

// --- SQL emission ------------------------------------------------------------
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sqlNum = (n) => (n == null ? 'NULL' : String(n));

const COLS = '(ts, isp, asn, city, region, country, postal, down, up, ping, jitter, loss, is_demo)';
function valueTuple(r) {
  return `(${r.tsSql}, ${sqlStr(r.isp)}, ${sqlNum(r.asn)}, ${sqlStr(r.city)}, `
    + `${sqlStr(r.region)}, ${sqlStr(r.country)}, ${sqlStr(r.postal)}, `
    + `${sqlNum(r.down)}, ${sqlNum(r.up)}, ${sqlNum(r.ping)}, ${sqlNum(r.jitter)}, `
    + `${sqlNum(r.loss)}, 1)`;
}

const CHUNK = 200;
const chunks = [];
for (let i = 0; i < rows.length; i += CHUNK) {
  const batch = rows.slice(i, i + CHUNK).map(valueTuple).join(',\n  ');
  chunks.push(`INSERT INTO results ${COLS} VALUES\n  ${batch};`);
}

const header = `-- Demo seed data for SpeedUndo's community store.
-- GENERATED by scripts/gen-seed.js — do not hand-edit; regenerate with:
--   node scripts/gen-seed.js
--
-- ${rows.length} rows, all is_demo = 1. Timestamps are apply-time-relative
-- (unixepoch('now',...)), so applying this migration always yields a fresh
-- 30-day demo window ending "now", with recent samples inside the 2 h health
-- window. Numeric values are deterministic (fixed-seed PRNG) — fully
-- reproducible. Aggregation never blends is_demo=1 with real (is_demo=0) rows.

`;

const out = path.join(__dirname, '..', 'migrations', '0002_seed_demo_data.sql');
fs.writeFileSync(out, header + chunks.join('\n\n') + '\n');
console.log(`wrote ${out} — ${rows.length} rows in ${chunks.length} INSERT statement(s)`);
