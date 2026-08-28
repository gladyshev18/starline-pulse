CREATE TABLE `device_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vehicle_id` integer NOT NULL,
	`type` integer NOT NULL,
	`group_id` integer,
	`ts` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `device_events_vehicle_ts_idx` ON `device_events` (`vehicle_id`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_events_unique` ON `device_events` (`vehicle_id`,`ts`,`type`);