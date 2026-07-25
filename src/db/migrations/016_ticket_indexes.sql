-- Indexes for the ticket lookups that run on hot paths (My Orders ticket
-- badges, admin ticket search, and the refill-status sync scan). Without these
-- these queries do full table scans as the tickets table grows at scale.
ALTER TABLE tickets ADD INDEX idx_tickets_order (order_id);
ALTER TABLE tickets ADD INDEX idx_tickets_status (status);
ALTER TABLE tickets ADD INDEX idx_tickets_refill (provider_action_status, provider_refill_id);
