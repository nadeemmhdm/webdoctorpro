PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  timezone_configured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  registered_at TEXT,
  registrar TEXT,
  rdap_url TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TEXT,
  next_check_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  domain_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notify_days TEXT NOT NULL DEFAULT '[30,14,7,3,1,0]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, domain_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(domain_id) REFERENCES domains(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  expiry_snapshot TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  UNIQUE(watch_id, kind, threshold, expiry_snapshot),
  FOREIGN KEY(watch_id) REFERENCES watches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_domains_next_check ON domains(next_check_at);
CREATE INDEX IF NOT EXISTS idx_watches_user_active ON watches(user_id, active);
CREATE INDEX IF NOT EXISTS idx_watches_domain_active ON watches(domain_id, active);
CREATE INDEX IF NOT EXISTS idx_notifications_watch ON notifications(watch_id);
