-- Account security: per-account lockout, a live audit trail, 2FA recovery
-- codes, and the signup fingerprints that make multi-account abuse visible.
-- Additive only; every statement is safe to re-run.

-- ── Per-account lockout ────────────────────────────────────
-- IP rate limiting alone does not stop credential stuffing: an attacker with a
-- thousand IPs makes one attempt each and never trips it. These count per
-- ACCOUNT, whichever address the attempt arrives from.
ALTER TABLE users ADD COLUMN failed_logins INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_failed_login_at DATETIME NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN locked_until DATETIME NULL DEFAULT NULL;

-- ── Signup fingerprints (multi-account detection) ──────────
ALTER TABLE users ADD COLUMN signup_ip VARCHAR(45) NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN signup_device VARCHAR(255) NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN fraud_flags VARCHAR(255) NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN fraud_score INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD INDEX idx_users_signup_ip (signup_ip);
ALTER TABLE users ADD INDEX idx_users_fraud (fraud_score);

-- ── Login log ──────────────────────────────────────────────
-- The table already existed but nothing has written to it since the rewrite.
-- These columns let it record failures too, which is the half that matters.
ALTER TABLE login_logs ADD COLUMN outcome VARCHAR(16) NOT NULL DEFAULT 'success';
ALTER TABLE login_logs ADD COLUMN username_tried VARCHAR(190) NULL DEFAULT NULL;
ALTER TABLE login_logs ADD COLUMN detail VARCHAR(190) NULL DEFAULT NULL;
ALTER TABLE login_logs MODIFY COLUMN user_id INT(11) NULL;
ALTER TABLE login_logs ADD INDEX idx_ll_user_time (user_id, created_at);
ALTER TABLE login_logs ADD INDEX idx_ll_ip_time (ip_address, created_at);
ALTER TABLE login_logs ADD INDEX idx_ll_outcome (outcome, created_at);

-- ── Audit log ──────────────────────────────────────────────
ALTER TABLE admin_audit_logs ADD INDEX idx_aal_admin (admin_id, created_at);
ALTER TABLE admin_audit_logs ADD INDEX idx_aal_module (affected_module, created_at);
ALTER TABLE admin_audit_logs ADD INDEX idx_aal_created (created_at);

-- ── 2FA recovery codes ─────────────────────────────────────
-- Enforced 2FA without these is a way to lock yourself out of your own panel
-- permanently the day you lose your phone.
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  code_hash VARCHAR(64) NOT NULL,
  used_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_trc_user (user_id),
  UNIQUE KEY uniq_trc_hash (code_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Linked accounts (multi-account) ────────────────────────
CREATE TABLE IF NOT EXISTS account_links (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  other_user_id INT UNSIGNED NOT NULL,
  reason VARCHAR(32) NOT NULL,        -- signup_ip | device | login_ip | payment_ref
  detail VARCHAR(190) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_link (user_id, other_user_id, reason),
  KEY idx_al_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Runtime toggles ────────────────────────────────────────
INSERT INTO settings (k, v) VALUES ('require_admin_2fa', 'on') ON DUPLICATE KEY UPDATE k = k;
INSERT INTO settings (k, v) VALUES ('login_lockout_enabled', 'on') ON DUPLICATE KEY UPDATE k = k;
INSERT INTO settings (k, v) VALUES ('fraud_link_detection', 'on') ON DUPLICATE KEY UPDATE k = k;
