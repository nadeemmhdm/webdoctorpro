ALTER TABLE domains ADD COLUMN ssl_expires_at TEXT;
ALTER TABLE domains ADD COLUMN ssl_issuer TEXT;
ALTER TABLE domains ADD COLUMN ssl_last_checked_at TEXT;
ALTER TABLE domains ADD COLUMN ssl_next_check_at TEXT;
ALTER TABLE domains ADD COLUMN hosting_provider TEXT;
ALTER TABLE domains ADD COLUMN dns_provider TEXT;
ALTER TABLE domains ADD COLUMN last_http_status INTEGER;
ALTER TABLE domains ADD COLUMN last_audit_at TEXT;

CREATE INDEX IF NOT EXISTS idx_domains_ssl_next_check ON domains(ssl_next_check_at);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
