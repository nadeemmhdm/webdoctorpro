PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS domain_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  record_name TEXT NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  UNIQUE(user_id, domain),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_domain_verifications_user_status ON domain_verifications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_domain_verifications_expiry ON domain_verifications(expires_at);

CREATE TABLE IF NOT EXISTS google_connections (
  user_id INTEGER PRIMARY KEY,
  token_cipher TEXT NOT NULL,
  scopes TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);

ALTER TABLE watches ADD COLUMN verified_at TEXT;
ALTER TABLE watches ADD COLUMN verification_id INTEGER;
ALTER TABLE watches ADD COLUMN report_schedule TEXT NOT NULL DEFAULT 'off';
ALTER TABLE watches ADD COLUMN next_report_at TEXT;
ALTER TABLE watches ADD COLUMN last_report_at TEXT;
ALTER TABLE watches ADD COLUMN ga_property_id TEXT;
ALTER TABLE watches ADD COLUMN uptime_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE watches ADD COLUMN uptime_last_status INTEGER;
ALTER TABLE watches ADD COLUMN uptime_last_checked_at TEXT;
ALTER TABLE watches ADD COLUMN uptime_changed_at TEXT;
ALTER TABLE watches ADD COLUMN uptime_last_error TEXT;
ALTER TABLE watches ADD COLUMN uptime_fail_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE domains ADD COLUMN last_seo_score INTEGER;
ALTER TABLE domains ADD COLUMN last_geo_score INTEGER;
ALTER TABLE domains ADD COLUMN last_aeo_score INTEGER;
ALTER TABLE domains ADD COLUMN last_pagespeed_score INTEGER;

CREATE INDEX IF NOT EXISTS idx_watches_uptime ON watches(active, verified_at, uptime_last_checked_at);
CREATE INDEX IF NOT EXISTS idx_watches_reports ON watches(active, report_schedule, next_report_at);
