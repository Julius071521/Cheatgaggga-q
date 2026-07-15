-- Some upstream services have min/max quantities larger than INT UNSIGNED can
-- hold (e.g. 10,000,000,000). Widen to BIGINT UNSIGNED so the catalog sync
-- never aborts on an out-of-range value.
ALTER TABLE services MODIFY COLUMN min_qty BIGINT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE services MODIFY COLUMN max_qty BIGINT UNSIGNED NOT NULL DEFAULT 1;
