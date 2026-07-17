-- Anti-fraud on deposit receipts + support the 7-day auto-refund. Additive only.

-- Fingerprint of the uploaded receipt image, so the SAME screenshot can't be
-- reused across accounts to fake a payment.
ALTER TABLE deposits ADD COLUMN receipt_hash VARCHAR(64) NULL;
ALTER TABLE deposits ADD KEY idx_deposits_receipt_hash (receipt_hash);

-- Marks orders the watchdog auto-refunded after going stuck too long (idempotency).
ALTER TABLE orders ADD COLUMN stuck_refunded_at TIMESTAMP NULL DEFAULT NULL;
