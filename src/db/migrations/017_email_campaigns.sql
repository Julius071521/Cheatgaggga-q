-- Marketing email automation: welcome campaign + "new services" digest.
--
-- services.created_at lets the digest tell genuinely new services from ones
-- that merely got re-synced (updated_at moves on every sync, so it cannot be
-- used for this). Existing rows are backdated a year so the very first digest
-- announces only what lands AFTER this migration — not the whole catalog.
ALTER TABLE services ADD COLUMN created_at DATETIME NULL DEFAULT NULL;
UPDATE services SET created_at = DATE_SUB(NOW(), INTERVAL 1 YEAR) WHERE created_at IS NULL;
ALTER TABLE services ADD INDEX idx_services_created (created_at);

-- Customers can opt out of marketing mail. Transactional mail (verification,
-- password reset, deposit and order notices) ignores this flag by design.
ALTER TABLE users ADD COLUMN email_optout TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN email_optout_at DATETIME NULL DEFAULT NULL;

-- One row per (user, campaign kind, campaign ref). The unique key is what
-- makes sending idempotent: a job that crashes and re-runs, or two overlapping
-- ticks, can never mail the same person the same campaign twice.
CREATE TABLE IF NOT EXISTS email_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  kind VARCHAR(40) NOT NULL,
  ref VARCHAR(120) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'sent',
  error VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_email_once (user_id, kind, ref),
  KEY idx_email_log_kind (kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO settings (k, v) VALUES ('email_campaigns', 'on') ON DUPLICATE KEY UPDATE k = k;
