-- Admin features: IP blocklist. (promos, promo_redemptions, tickets and
-- user_notifications already exist in the production database.)

CREATE TABLE IF NOT EXISTS blocked_ips (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(45) NOT NULL UNIQUE,
  reason VARCHAR(255) NULL,
  blocked_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Safety net in case an older DB is missing promo columns this build relies on.
ALTER TABLE promos ADD COLUMN IF NOT EXISTS max_discount_amount DECIMAL(15,2) NULL;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS uses INT NOT NULL DEFAULT 0;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS active TINYINT(1) NOT NULL DEFAULT 1;
