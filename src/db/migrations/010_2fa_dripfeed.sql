-- Admin/user 2FA (TOTP) + drip-feed order parameters. Additive only.

ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64) NULL;
ALTER TABLE users ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE orders ADD COLUMN runs INT NULL;
ALTER TABLE orders ADD COLUMN interval_minutes INT NULL;
