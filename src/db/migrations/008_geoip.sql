-- Geolocation + richer intel for flagged IPs. Additive only.
ALTER TABLE ip_reputation ADD COLUMN country VARCHAR(64) NULL;
ALTER TABLE ip_reputation ADD COLUMN country_code VARCHAR(4) NULL;
ALTER TABLE ip_reputation ADD COLUMN city VARCHAR(96) NULL;
ALTER TABLE ip_reputation ADD COLUMN isp VARCHAR(128) NULL;
ALTER TABLE ip_reputation ADD COLUMN is_proxy TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE ip_reputation ADD COLUMN geo_done TINYINT(1) NOT NULL DEFAULT 0;
