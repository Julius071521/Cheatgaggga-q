-- Idempotent reseller orders: a client can pass client_order_id so a retried
-- request (e.g. after a timeout) never creates a second order or double-charges
-- the wallet. The unique key enforces one order per (user, client_order_id).
ALTER TABLE orders ADD COLUMN client_order_id VARCHAR(64) NULL;
CREATE UNIQUE INDEX uniq_client_order ON orders (user_id, client_order_id);
