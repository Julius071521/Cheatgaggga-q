-- Real customer reviews: only a customer with a Completed order can leave one,
-- one review per order. Shown on the homepage (real social proof, no fakes).
CREATE TABLE IF NOT EXISTS reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  order_id INT NOT NULL,
  rating TINYINT NOT NULL,                 -- 1..5
  body VARCHAR(600) NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'visible',  -- visible | hidden
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_review_order (order_id),
  KEY idx_reviews_status (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
