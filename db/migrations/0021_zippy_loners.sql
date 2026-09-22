CREATE TABLE `removed_trips` (
	`trip_id` integer PRIMARY KEY NOT NULL,
	`vehicle_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`driver` text,
	`driver_asked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `removed_trips_vehicle_started_idx` ON `removed_trips` (`vehicle_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `trips` ADD `driver_asked_at` integer;--> statement-breakpoint
UPDATE `trips` SET `driver_asked_at` = `ended_at` WHERE `is_open` = 0;