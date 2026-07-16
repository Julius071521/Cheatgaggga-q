-- Threat Radar: attacker/scanner detection + IP reputation. Additive only.

CREATE TABLE IF NOT EXISTS security_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(45) NOT NULL,
  kind VARCHAR(24) NOT NULL,
  method VARCHAR(8) NULL,
  path VARCHAR(255) NULL,
  user_agent VARCHAR(255) NULL,
  detail VARCHAR(255) NULL,
  score INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_se_ip (ip),
  KEY idx_se_created (created_at),
  KEY idx_se_kind (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ip_reputation (
  ip VARCHAR(45) PRIMARY KEY,
  score INT NOT NULL DEFAULT 0,
  status VARCHAR(12) NULL,               -- NULL | 'watch' | 'blocked' | 'allowed'
  events_count INT NOT NULL DEFAULT 0,
  last_kind VARCHAR(24) NULL,
  last_path VARCHAR(255) NULL,
  user_agent VARCHAR(255) NULL,
  first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  alerted_at TIMESTAMP NULL DEFAULT NULL,
  KEY idx_ir_status (status),
  KEY idx_ir_score (score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Runtime toggles (admin can flip from the panel).
INSERT INTO settings (k, v) VALUES ('security_enabled', 'on') ON DUPLICATE KEY UPDATE k = k;
INSERT INTO settings (k, v) VALUES ('security_auto_block', 'off') ON DUPLICATE KEY UPDATE k = k;
