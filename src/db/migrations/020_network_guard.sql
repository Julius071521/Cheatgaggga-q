-- Network Guard: identify VPN / proxy / datacenter (VPS) traffic and act on it.
-- Additive only; safe to re-run.

CREATE TABLE IF NOT EXISTS ip_intel (
  ip VARCHAR(45) PRIMARY KEY,
  -- residential | hosting | vpn | proxy | tor | unknown
  kind VARCHAR(16) NOT NULL DEFAULT 'unknown',
  org VARCHAR(128) NULL,
  asn VARCHAR(24) NULL,
  country_code VARCHAR(4) NULL,
  is_hosting TINYINT(1) NOT NULL DEFAULT 0,
  is_vpn TINYINT(1) NOT NULL DEFAULT 0,
  is_proxy TINYINT(1) NOT NULL DEFAULT 0,
  is_tor TINYINT(1) NOT NULL DEFAULT 0,
  -- 'local' = matched a shipped datacenter range, 'remote' = intelligence API,
  -- 'manual' = an admin decided. 'manual' is never overwritten by a lookup.
  source VARCHAR(16) NOT NULL DEFAULT 'remote',
  hits INT NOT NULL DEFAULT 0,
  blocked_hits INT NOT NULL DEFAULT 0,
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP NULL DEFAULT NULL,
  KEY idx_ii_kind (kind),
  KEY idx_ii_checked (checked_at),
  KEY idx_ii_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Runtime toggles, flipped from the admin panel without a redeploy.
-- Mode: off | monitor | guard | block
INSERT INTO settings (k, v) VALUES ('netguard_mode', 'block') ON DUPLICATE KEY UPDATE k = k;
INSERT INTO settings (k, v) VALUES ('netguard_hosting', 'on') ON DUPLICATE KEY UPDATE k = k;
INSERT INTO settings (k, v) VALUES ('netguard_vpn', 'on') ON DUPLICATE KEY UPDATE k = k;
INSERT INTO settings (k, v) VALUES ('netguard_proxy', 'on') ON DUPLICATE KEY UPDATE k = k;
INSERT INTO settings (k, v) VALUES ('netguard_tor', 'on') ON DUPLICATE KEY UPDATE k = k;
