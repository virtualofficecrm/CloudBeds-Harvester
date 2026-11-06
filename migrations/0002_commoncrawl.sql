-- Safe to run on the live DB: only creates new tables.
-- wrangler d1 execute cloudbeds --remote --file=./migrations/0002_commoncrawl.sql

CREATE TABLE IF NOT EXISTS cc_codes (
  cb_code     TEXT PRIMARY KEY,
  crawl       TEXT,
  seen_at     TEXT,
  status      TEXT,          -- NULL pending | us | non-us | no-jsonld | known
  enriched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_status ON cc_codes(status);

CREATE TABLE IF NOT EXISTS exclusions (
  key      TEXT PRIMARY KEY,  -- code:XXXXXX | email:x@y | phone:10digits | host:example.com
  added_at TEXT
);
