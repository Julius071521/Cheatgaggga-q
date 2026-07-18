-- Pending, owner-confirmable actions proposed by the Telegram AI admin agent.
-- Money-moving / risky actions (add funds, refund, ban, broadcast…) are NOT
-- executed straight away — the agent stores them here and the owner taps a
-- Confirm/Cancel button in Telegram. The short token goes in the button's
-- callback_data (Telegram's 64-byte limit can't hold full args, so we key by
-- token and keep the real payload here).
CREATE TABLE IF NOT EXISTS agent_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token VARCHAR(24) NOT NULL UNIQUE,
  action VARCHAR(32) NOT NULL,
  args TEXT NULL,
  summary VARCHAR(300) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'pending',   -- pending | done | canceled | expired
  result VARCHAR(400) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP NULL DEFAULT NULL,
  KEY idx_aa_status (status),
  KEY idx_aa_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
