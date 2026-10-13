PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_activation_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_chat_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_activation_codes_user ON team_activation_codes(user_id,expires_at);

CREATE TABLE IF NOT EXISTS team_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL UNIQUE,
  owner_user_id INTEGER NOT NULL,
  chat_type TEXT NOT NULL,
  title TEXT,
  plan_expires_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  activated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_chats_chat_active ON team_chats(chat_id,active,plan_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_chats_one_active_owner ON team_chats(owner_user_id) WHERE active=1;
