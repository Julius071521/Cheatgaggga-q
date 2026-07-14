-- Adaptive migration: works WITH the existing production database.
-- It never recreates or drops users/orders/deposits/transactions/otp_codes/
-- password_reset_tokens — it only adds the few support tables and columns the
-- new front-end needs. Safe to run repeatedly.

-- Provider registry (new)
CREATE TABLE IF NOT EXISTS providers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  balance_usd DECIMAL(12,4) NULL,
  currency VARCHAR(8) NULL DEFAULT 'USD',
  synced_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Local service catalog synced from providers (new)
CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id INT UNSIGNED NOT NULL,
  provider_service_id VARCHAR(50) NOT NULL,
  platform VARCHAR(32) NOT NULL DEFAULT 'other',
  category VARCHAR(190) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  type VARCHAR(64) NOT NULL DEFAULT 'Default',
  rate_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
  min_qty INT UNSIGNED NOT NULL DEFAULT 1,
  max_qty INT UNSIGNED NOT NULL DEFAULT 1,
  refill TINYINT(1) NOT NULL DEFAULT 0,
  cancelable TINYINT(1) NOT NULL DEFAULT 0,
  dripfeed TINYINT(1) NOT NULL DEFAULT 0,
  markup_override DECIMAL(6,3) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  deleted TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_provider_service (provider_id, provider_service_id),
  INDEX idx_platform (platform),
  INDEX idx_enabled (enabled, deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Key/value settings (new)
CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(64) PRIMARY KEY,
  v TEXT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- AI chat transcript log (new)
CREATE TABLE IF NOT EXISTS ai_chat_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  session_id VARCHAR(128) NULL,
  role VARCHAR(16) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Extend the existing deposits table so admins can attach receipts + review
-- notes. Additive only — existing rows/data are untouched.
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS receipt_path VARCHAR(255) NULL;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS admin_note VARCHAR(500) NULL;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS reviewed_by INT NULL;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS reviewed_at DATETIME NULL;
