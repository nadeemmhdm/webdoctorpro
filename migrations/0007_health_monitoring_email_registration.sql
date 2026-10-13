PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN notification_email TEXT;
ALTER TABLE watches ADD COLUMN incident_started_at TEXT;
ALTER TABLE watches ADD COLUMN last_change_check_at TEXT;
ALTER TABLE watches ADD COLUMN last_health_score INTEGER;
ALTER TABLE watches ADD COLUMN last_health_at TEXT;

CREATE TABLE IF NOT EXISTS uptime_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  state TEXT NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  FOREIGN KEY(watch_id) REFERENCES watches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_uptime_samples_watch_time ON uptime_samples(watch_id,checked_at);

CREATE TABLE IF NOT EXISTS uptime_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  start_status INTEGER,
  recovery_status INTEGER,
  duration_seconds INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(watch_id) REFERENCES watches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_uptime_incidents_watch_open ON uptime_incidents(watch_id,ended_at,started_at);

CREATE TABLE IF NOT EXISTS website_snapshots (
  watch_id INTEGER PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  FOREIGN KEY(watch_id) REFERENCES watches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS website_change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  detected_at TEXT NOT NULL,
  FOREIGN KEY(watch_id) REFERENCES watches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_change_events_watch_time ON website_change_events(watch_id,detected_at);

CREATE TABLE IF NOT EXISTS scan_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER,
  user_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  health_score INTEGER NOT NULL,
  domain_score INTEGER NOT NULL,
  ssl_score INTEGER NOT NULL,
  security_score INTEGER NOT NULL,
  seo_score INTEGER NOT NULL,
  performance_score INTEGER NOT NULL,
  dns_score INTEGER NOT NULL,
  availability_score INTEGER NOT NULL,
  broken_links INTEGER NOT NULL DEFAULT 0,
  load_ms INTEGER,
  fixes_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(watch_id) REFERENCES watches(id) ON DELETE SET NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scan_history_domain_time ON scan_history(user_id,domain,scanned_at);

CREATE TABLE IF NOT EXISTS smtp_config (
  id INTEGER PRIMARY KEY CHECK(id=1),
  sender_email TEXT NOT NULL,
  app_password_cipher TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registration_waitlist (
  telegram_user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  notified_reopened_at TEXT
);

INSERT INTO app_meta(key,value,updated_at)
VALUES('registrations_open','1',datetime('now'))
ON CONFLICT(key) DO NOTHING;
