-- Concern actions become state instead of a single "last action" string, so the
-- admin panel can hide a button once its action is done. Additive + re-runnable.

CREATE TABLE IF NOT EXISTS ticket_actions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT UNSIGNED NOT NULL,
  action VARCHAR(16) NOT NULL,          -- refill | speedup | cancel | refund
  ok TINYINT(1) NOT NULL DEFAULT 1,     -- 0 = attempt failed, button stays available
  detail VARCHAR(500) NULL,
  admin_id INT UNSIGNED NULL,           -- NULL = done by autopilot
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ta_ticket (ticket_id),
  KEY idx_ta_action (ticket_id, action, ok)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backfill from the old single-value column so concerns already handled show
-- the right buttons the moment this deploys, instead of offering actions the
-- team has already taken. INSERT ... SELECT with the NOT EXISTS guard makes
-- this safe to run more than once.
INSERT INTO ticket_actions (ticket_id, action, ok, detail, created_at)
SELECT t.id,
       CASE
         WHEN t.provider_action_status LIKE 'refill%' THEN 'refill'
         WHEN t.provider_action_status LIKE 'cancel%' THEN 'cancel'
         WHEN t.provider_action_status LIKE 'speedup%' THEN 'speedup'
         WHEN t.provider_action_status = 'refunded' THEN 'refund'
       END,
       1,
       CONCAT('Backfilled from provider_action_status=', t.provider_action_status),
       t.created_at
FROM tickets t
WHERE t.provider_action_status IS NOT NULL
  AND t.provider_action_status <> ''
  AND (t.provider_action_status LIKE 'refill%'
       OR t.provider_action_status LIKE 'cancel%'
       OR t.provider_action_status LIKE 'speedup%'
       OR t.provider_action_status = 'refunded')
  AND NOT EXISTS (SELECT 1 FROM ticket_actions a WHERE a.ticket_id = t.id);
