ALTER TABLE `vehicle_snapshots` ADD `armed` integer;--> statement-breakpoint
UPDATE `vehicle_snapshots` SET `armed` = json_extract(`raw_json`, '$.data.state.arm')
	WHERE `armed` IS NULL AND json_extract(`raw_json`, '$.data.state.arm') IS NOT NULL;
