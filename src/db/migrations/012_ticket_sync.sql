-- Ticket ↔ provider sync: track the provider's refill request id so we can
-- follow up (refill_status) until it completes, and backfill provider linkage
-- on older tickets so every ticket matches its order's provider order number.
ALTER TABLE tickets ADD COLUMN provider_refill_id VARCHAR(32) NULL;

-- Backfill: older tickets created before provider linkage was stored.
-- CONVERT both sides so mixed collations (old vs new tables) can never error.
UPDATE tickets t
JOIN orders o
  ON CONVERT(o.order_id USING utf8mb4) = CONVERT(t.order_id USING utf8mb4)
SET t.provider_order_id = o.provider_order_id,
    t.api_provider = o.api_provider
WHERE t.provider_order_id IS NULL
  AND t.order_id IS NOT NULL
  AND o.provider_order_id IS NOT NULL;
