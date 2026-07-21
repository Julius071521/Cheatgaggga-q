-- Two-way support chat: a message thread per ticket so customers and staff can
-- go back and forth (before this, tickets were one-way — a report + a one-off
-- notification). The original ticket.message stays the first customer message.
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,
  sender VARCHAR(10) NOT NULL DEFAULT 'customer',  -- customer | staff | system
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tm_ticket (ticket_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Track unread state so each side sees a badge for new replies.
ALTER TABLE tickets ADD COLUMN customer_unread TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN staff_unread TINYINT(1) NOT NULL DEFAULT 0;
