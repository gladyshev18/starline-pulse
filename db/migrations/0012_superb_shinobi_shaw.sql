CREATE TABLE `service_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vehicle_id` integer NOT NULL,
	`kind` text DEFAULT 'oil' NOT NULL,
	`performed_at` integer NOT NULL,
	`mileage` real,
	`motor_minutes` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `service_events_vehicle_kind_idx` ON `service_events` (`vehicle_id`,`kind`,`performed_at`);--> statement-breakpoint
ALTER TABLE `vehicle_snapshots` ADD `motor_minutes` integer;--> statement-breakpoint
UPDATE `vehicle_snapshots` SET `motor_minutes` = json_extract(`raw_json`, '$.data.state.motohrs')
	WHERE `motor_minutes` IS NULL AND json_extract(`raw_json`, '$.data.state.motohrs') IS NOT NULL;
