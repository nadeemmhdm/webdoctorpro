PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN plan_expires_at TEXT;
ALTER TABLE users ADD COLUMN subscription_charge_id TEXT;
ALTER TABLE users ADD COLUMN subscription_auto_renew INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by INTEGER;
ALTER TABLE users ADD COLUMN referral_rewarded_at TEXT;
ALTER TABLE users ADD COLUMN last_seen_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan, plan_expires_at);
CREATE INDEX IF NOT EXISTS idx_users_blocked ON users(blocked);

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  scan_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  ad_eligible_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, day_key),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS star_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XTR',
  invoice_payload TEXT NOT NULL,
  telegram_charge_id TEXT NOT NULL UNIQUE,
  provider_charge_id TEXT,
  subscription_expiration_date TEXT,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  is_first_recurring INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_star_payments_user ON star_payments(user_id, created_at);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,
  bonus_days INTEGER NOT NULL DEFAULT 0,
  bonus_coins INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coupons_active_expiry ON coupons(active, expires_at);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL,
  UNIQUE(coupon_id, user_id),
  FOREIGN KEY(coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  content_type TEXT NOT NULL,
  text_content TEXT,
  telegram_file_id TEXT,
  buttons_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_active ON ads(active, id);

CREATE TABLE IF NOT EXISTS ad_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  viewed_at TEXT NOT NULL,
  FOREIGN KEY(ad_id) REFERENCES ads(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ad_views_user ON ad_views(user_id, viewed_at);

CREATE TABLE IF NOT EXISTS pending_message_deletes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  delete_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_message_deletes_due ON pending_message_deletes(delete_at);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_type TEXT NOT NULL,
  text_content TEXT,
  telegram_file_id TEXT,
  buttons_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  cursor_user_id INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broadcast_status ON broadcasts(status, id);

CREATE TABLE IF NOT EXISTS admin_sessions (
  admin_user_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  FOREIGN KEY(admin_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS google_user_configs (
  user_id INTEGER PRIMARY KEY,
  client_id_cipher TEXT NOT NULL,
  client_secret_cipher TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO app_meta(key,value,updated_at)
SELECT 'admin_user_id', telegram_user_id, datetime('now') FROM users WHERE (SELECT COUNT(*) FROM users)=1 ORDER BY id ASC LIMIT 1
ON CONFLICT(key) DO NOTHING;

INSERT INTO app_meta(key,value,updated_at) VALUES('ads_enabled','1',datetime('now'))
ON CONFLICT(key) DO NOTHING;
