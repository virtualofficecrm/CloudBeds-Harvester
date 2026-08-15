CREATE TABLE IF NOT EXISTS checked (
  domain        TEXT PRIMARY KEY,
  is_cloudbeds  INTEGER NOT NULL DEFAULT 0,
  checked_at    TEXT
);

CREATE TABLE IF NOT EXISTS properties (
  cb_code         TEXT PRIMARY KEY,
  name            TEXT,
  phone           TEXT,
  email           TEXT,
  website         TEXT,
  street          TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  country         TEXT,
  checkin         TEXT,
  checkout        TEXT,
  room_types      TEXT,
  room_type_count INTEGER,
  has_24h_desk    INTEGER DEFAULT 0,
  lat             REAL,
  lng             REAL,
  source_domain   TEXT,
  found_at        TEXT,
  synced_at       TEXT,
  sync_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_prop_country ON properties(country);
CREATE INDEX IF NOT EXISTS idx_prop_sync    ON properties(synced_at);
CREATE INDEX IF NOT EXISTS idx_checked_cb   ON checked(is_cloudbeds);
