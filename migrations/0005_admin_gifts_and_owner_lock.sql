PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  coins INTEGER NOT NULL CHECK(coins > 0),
  status TEXT NOT NULL DEFAULT 'pending',
  notified_at TEXT,
  claimed_at TEXT,
  created_by_telegram_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_gifts_pending ON user_gifts(user_id,status,id);

INSERT INTO app_meta(key,value,updated_at) VALUES('admin_user_id','8984229401',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value='8984229401', updated_at=datetime('now');
