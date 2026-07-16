-- Growth features: deposit bonus tiers, referral commissions, payout requests,
-- and deposit auto-approval marker. Additive only — no existing data touched.

ALTER TABLE users ADD COLUMN referral_code VARCHAR(20) NULL;

ALTER TABLE users ADD UNIQUE KEY uq_users_refcode (referral_code);

ALTER TABLE users ADD COLUMN referred_by INT NULL;

ALTER TABLE deposits ADD COLUMN bonus_amount DECIMAL(15,4) NULL;

ALTER TABLE deposits ADD COLUMN auto_approved TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS referral_commissions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  referrer_id INT NOT NULL,
  referred_user_id INT NOT NULL,
  deposit_id INT NULL,
  deposit_amount DECIMAL(15,4) NOT NULL,
  amount DECIMAL(15,4) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rc_referrer (referrer_id),
  UNIQUE KEY uq_rc_deposit (deposit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payout_requests (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  amount DECIMAL(15,4) NOT NULL,
  method VARCHAR(20) NOT NULL,
  account_number VARCHAR(50) NOT NULL,
  account_name VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  admin_note VARCHAR(500) NULL,
  processed_by INT NULL,
  processed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pr_user (user_id),
  KEY idx_pr_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
