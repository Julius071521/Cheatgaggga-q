-- ONE canonical, human-readable order code.
--
-- Before this, a single order answered to four different identifiers depending
-- on where you looked: the DB row id (#163) on the customer's pages, the
-- APX-<timestamp>-<rand> code in admin, a substring of that code in the wallet
-- ledger, and the upstream provider's id in support tickets. Customers could
-- not search for the number they were shown, and staff could not join a
-- customer's reference to a provider order without guessing.
--
-- public_code is now the single value shown everywhere. The old code is kept
-- in legacy_code so existing emails, notifications, ledger rows and ticket
-- references still resolve.
ALTER TABLE orders ADD COLUMN public_code VARCHAR(32) NULL DEFAULT NULL;
ALTER TABLE orders ADD COLUMN legacy_code VARCHAR(64) NULL DEFAULT NULL;
ALTER TABLE orders ADD COLUMN provider_key VARCHAR(24) NULL DEFAULT NULL;
ALTER TABLE orders ADD COLUMN refill_id VARCHAR(64) NULL DEFAULT NULL;
ALTER TABLE orders ADD COLUMN refill_status VARCHAR(32) NULL DEFAULT NULL;
ALTER TABLE orders ADD COLUMN provider_charge DECIMAL(14,6) NULL DEFAULT NULL;
ALTER TABLE orders ADD COLUMN provider_currency VARCHAR(8) NULL DEFAULT NULL;
ALTER TABLE orders ADD COLUMN provider_created_at DATETIME NULL DEFAULT NULL;
ALTER TABLE orders ADD COLUMN last_synced_at DATETIME NULL DEFAULT NULL;

-- Backfill: the existing order_id column already holds the legacy APX code.
UPDATE orders SET legacy_code = order_id WHERE legacy_code IS NULL;
UPDATE orders SET public_code = CONCAT('APX-', LPAD(id, 6, '0')) WHERE public_code IS NULL;
UPDATE orders SET provider_key = CASE
    WHEN api_provider = 'SMMWorld' THEN 'smmworld'
    WHEN api_provider = 'RKDPanel' THEN 'rkd'
    ELSE LOWER(COALESCE(api_provider, ''))
  END
  WHERE provider_key IS NULL OR provider_key = '';

ALTER TABLE orders ADD UNIQUE KEY uniq_orders_public_code (public_code);
ALTER TABLE orders ADD KEY idx_orders_legacy_code (legacy_code);
ALTER TABLE orders ADD KEY idx_orders_refill (refill_id);

-- One local row per upstream order. Rows without a provider id are excluded by
-- MySQL's NULL handling in unique keys, so unsent orders don't collide.
ALTER TABLE orders ADD UNIQUE KEY uniq_provider_order (provider_key, provider_order_id);
