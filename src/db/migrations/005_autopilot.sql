-- Autopilot: AI-managed ticket triage + stuck-order watchdog.
-- Additive only — never touches existing production data.

CREATE TABLE IF NOT EXISTS autopilot_log (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NULL,
  order_ref VARCHAR(255) NULL,
  user_id INT NULL,
  action VARCHAR(60) NOT NULL,
  detail TEXT NULL,
  outcome VARCHAR(20) NOT NULL DEFAULT 'done',
  acknowledged TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ap_outcome (outcome, acknowledged),
  KEY idx_ap_order (order_ref),
  KEY idx_ap_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Marks tickets the autopilot has already triaged (so it never re-processes).
ALTER TABLE tickets ADD COLUMN ai_handled_at TIMESTAMP NULL DEFAULT NULL;

-- Runtime toggle (admin can flip it from the panel).
INSERT INTO settings (k, v) VALUES ('autopilot', 'on')
  ON DUPLICATE KEY UPDATE k = k;
