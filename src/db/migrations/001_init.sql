CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NULL,
  name VARCHAR(100) NOT NULL DEFAULT '',
  google_id VARCHAR(64) NULL UNIQUE,
  role ENUM('user','admin') NOT NULL DEFAULT 'user',
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  api_key CHAR(64) NULL UNIQUE,
  email_verified_at DATETIME NULL,
  banned_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  purpose ENUM('verify','reset') NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_token_hash (token_hash),
  CONSTRAINT fk_email_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS providers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  balance_usd DECIMAL(12,4) NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  synced_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id INT UNSIGNED NOT NULL,
  provider_service_id VARCHAR(32) NOT NULL,
  platform VARCHAR(32) NOT NULL DEFAULT 'other',
  category VARCHAR(190) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  type VARCHAR(64) NOT NULL DEFAULT 'Default',
  rate_usd DECIMAL(12,6) NOT NULL,
  min_qty INT UNSIGNED NOT NULL DEFAULT 1,
  max_qty INT UNSIGNED NOT NULL DEFAULT 1,
  refill TINYINT(1) NOT NULL DEFAULT 0,
  cancelable TINYINT(1) NOT NULL DEFAULT 0,
  dripfeed TINYINT(1) NOT NULL DEFAULT 0,
  markup_override DECIMAL(8,3) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  deleted TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_provider_service (provider_id, provider_service_id),
  INDEX idx_platform (platform),
  INDEX idx_enabled (enabled, deleted),
  CONSTRAINT fk_services_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  service_id INT UNSIGNED NOT NULL,
  provider_order_id VARCHAR(32) NULL,
  link VARCHAR(500) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  charge_php DECIMAL(12,2) NOT NULL,
  cost_usd DECIMAL(12,6) NOT NULL,
  status ENUM('pending','in_progress','processing','completed','partial','canceled','failed') NOT NULL DEFAULT 'pending',
  refunded_php DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  start_count INT NULL,
  remains INT NULL,
  error VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_orders_user (user_id),
  INDEX idx_orders_status (status),
  INDEX idx_orders_provider_order (provider_order_id),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_service FOREIGN KEY (service_id) REFERENCES services(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS deposits (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  method ENUM('gcash','maya','bpi') NOT NULL,
  amount_php DECIMAL(12,2) NOT NULL,
  reference_no VARCHAR(100) NOT NULL,
  receipt_path VARCHAR(255) NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  admin_note VARCHAR(500) NULL,
  reviewed_by INT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_deposits_user (user_id),
  INDEX idx_deposits_status (status),
  CONSTRAINT fk_deposits_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS transactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  type ENUM('deposit','order','refund','adjustment') NOT NULL,
  amount_php DECIMAL(12,2) NOT NULL,
  balance_after DECIMAL(12,2) NOT NULL,
  ref_type VARCHAR(32) NULL,
  ref_id INT UNSIGNED NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_transactions_user (user_id),
  CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(64) PRIMARY KEY,
  v TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_chat_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  session_id VARCHAR(64) NOT NULL,
  role ENUM('user','assistant') NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
