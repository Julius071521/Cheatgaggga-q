-- Self-service refill / cancel, with a retry queue.
--
-- Every refill and cancel used to travel as a support ticket: the customer
-- described the problem, autopilot guessed the intent, forwarded it once, and
-- if the provider replied "Cancel unavailable. Try again later." the ticket sat
-- IN_PROGRESS forever with nobody retrying it. This gives those requests their
-- own record with an attempt count and a next-attempt time.
CREATE TABLE IF NOT EXISTS order_actions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  user_id INT NOT NULL,
  kind VARCHAR(16) NOT NULL,               -- refill | cancel
  status VARCHAR(20) NOT NULL DEFAULT 'queued', -- queued|sent|completed|rejected|failed
  provider_refill_id VARCHAR(64) NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NULL,
  last_error VARCHAR(255) NULL,
  provider_response TEXT NULL,
  -- Set to "<order_id>:<kind>" while the action is live and cleared when it
  -- finishes. The unique key then allows any number of finished actions but
  -- only one live one per order+kind, which is what stops duplicate requests.
  live_key VARCHAR(48) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_live_action (live_key),
  KEY idx_actions_order (order_id),
  KEY idx_actions_due (status, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Refill eligibility depends on how long ago the order completed, which was
-- never recorded. New completions stamp it; existing rows stay NULL and are
-- treated as "completed long ago", which is true for all of them.
ALTER TABLE orders ADD COLUMN completed_at DATETIME NULL DEFAULT NULL;
ALTER TABLE orders ADD KEY idx_orders_completed (completed_at);

-- Same duplicate guard for tickets: #67 and #68 were byte-identical, filed in
-- the same minute against the same order.
ALTER TABLE tickets ADD COLUMN dedupe_key VARCHAR(96) NULL DEFAULT NULL;
UPDATE tickets SET dedupe_key = CONCAT(order_id, ':', request_type)
  WHERE order_id IS NOT NULL AND request_type IS NOT NULL
    AND LOWER(status) IN ('open', 'in_progress')
    AND id IN (SELECT * FROM (
      SELECT MIN(id) FROM tickets
       WHERE order_id IS NOT NULL AND request_type IS NOT NULL
         AND LOWER(status) IN ('open', 'in_progress')
       GROUP BY order_id, request_type) keep);
ALTER TABLE tickets ADD UNIQUE KEY uniq_open_ticket (dedupe_key);
