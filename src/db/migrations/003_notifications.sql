-- Notifications: a global "updates" feed (new promos / new services) plus a
-- per-user "seen" marker. Personal notifications reuse the existing
-- user_notifications table.

CREATE TABLE IF NOT EXISTS updates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(40) NOT NULL DEFAULT 'news',
  title VARCHAR(180) NOT NULL,
  message VARCHAR(500) NULL,
  url VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_seen_at DATETIME NULL;
