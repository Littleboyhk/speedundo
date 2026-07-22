-- SpeedUndo community results store (D1 / SQLite).
-- Replaces data/results.json. One row per submitted speed test.
--
-- COLLATE NOCASE on isp/city/postal means equality and GROUP BY on these
-- columns are already case-insensitive at the SQLite engine level — no need
-- to LOWER()/TRIM() in every query the way server.js's norm() helper did.
-- (Values are still trimmed at write time in the Worker, same as cleanStr().)

CREATE TABLE results (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,              -- epoch ms, same as Date.now() in server.js
  isp     TEXT    NOT NULL COLLATE NOCASE,
  asn     INTEGER,                       -- nullable: some ISPs report without ASN
  city    TEXT    NOT NULL COLLATE NOCASE,
  region  TEXT,
  country TEXT,
  postal  TEXT    COLLATE NOCASE,
  down    REAL    NOT NULL,
  up      REAL,
  ping    REAL,
  jitter  REAL,
  loss    REAL,
  -- is_demo: 1 = demo seed data, 0 = real submission. SQLite has no boolean
  -- type; INTEGER 0/1 is the convention. Aggregation NEVER blends the two —
  -- a scope shows real numbers once real submissions exist, otherwise it
  -- serves demo data explicitly flagged as such (see filterRecords/splitDemo
  -- in src/worker.js). Kept out of the composite indexes: scoped result sets
  -- are small (<= 20k-row cap, one city/window), so the real/demo split is a
  -- cheap in-JS partition rather than an indexed predicate.
  is_demo INTEGER NOT NULL DEFAULT 0
);

-- Cap/cleanup: "delete oldest beyond MAX_RECORDS" needs ts-ordered access to
-- the whole table (no other filter), so a plain ts index is enough.
CREATE INDEX idx_results_ts ON results (ts);

-- Leaderboard / patterns / outage / stats all filter by city and/or postal
-- and then restrict to a recency window (ts >= cutoff). Composite indexes
-- with ts last let SQLite satisfy "WHERE city = ? AND ts >= ?" from the index
-- directly instead of a full scan.
CREATE INDEX idx_results_city_ts   ON results (city, ts);
CREATE INDEX idx_results_postal_ts ON results (postal, ts);

-- /api/patterns and /api/outage also filter by isp name directly (no city).
CREATE INDEX idx_results_isp_ts ON results (isp, ts);

-- Grouping by ASN (the critical fix from the audit) benefits from its own
-- index since asn is queried independently of city/postal in the leaderboard
-- scope query.
CREATE INDEX idx_results_asn_ts ON results (asn, ts);
