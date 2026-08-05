ALTER TABLE `vehicle_snapshots` ADD `online` integer;--> statement-breakpoint
ALTER TABLE `vehicle_snapshots` ADD `mileage_ts` integer;--> statement-breakpoint
ALTER TABLE `vehicle_snapshots` ADD `fuel_percent` real;--> statement-breakpoint
ALTER TABLE `vehicle_snapshots` ADD `fuel_ts` integer;--> statement-breakpoint
ALTER TABLE `vehicle_snapshots` ADD `fuel_source` text;--> statement-breakpoint
ALTER TABLE `vehicle_snapshots` ADD `battery_type` text;--> statement-breakpoint
ALTER TABLE `vehicle_snapshots` ADD `common_ts` integer;--> statement-breakpoint
ALTER TABLE `vehicle_snapshots` ADD `position_ts` integer;--> statement-breakpoint
UPDATE `vehicle_snapshots`
SET `lat` = `lon`, `lon` = `lat`
WHERE `lat` IS NOT NULL AND `lon` IS NOT NULL;--> statement-breakpoint
UPDATE `trips`
SET `lat_start` = `lon_start`, `lon_start` = `lat_start`
WHERE `lat_start` IS NOT NULL AND `lon_start` IS NOT NULL;--> statement-breakpoint
UPDATE `trips`
SET `lat_end` = `lon_end`, `lon_end` = `lat_end`
WHERE `lat_end` IS NOT NULL AND `lon_end` IS NOT NULL;--> statement-breakpoint
UPDATE `vehicle_snapshots`
SET `raw_json` = '{"migrated":true,"reason":"legacy payload removed for privacy"}';--> statement-breakpoint
UPDATE `api_calls`
SET `endpoint` = '/json/v3/device/[СКРЫТО]/data', `url` = NULL, `response_body` = NULL
WHERE `endpoint` LIKE '/json/v3/device/%/data';
