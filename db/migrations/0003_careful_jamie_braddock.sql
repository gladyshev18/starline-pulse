CREATE TABLE `engine_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vehicle_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`first_movement_at` integer,
	`mileage_start` real,
	`mileage_end` real,
	`fuel_start` real,
	`fuel_end` real,
	`distance` real,
	`duration_minutes` real,
	`warmup_minutes` real,
	`is_stationary` integer,
	`is_open` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `engine_sessions_vehicle_started_idx` ON `engine_sessions` (`vehicle_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `refuel_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vehicle_id` integer NOT NULL,
	`detected_at` integer NOT NULL,
	`mileage` real,
	`fuel_before` real,
	`fuel_after` real,
	`litres_added` real,
	`percent_before` real,
	`percent_after` real,
	`lat` real,
	`lon` real,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `refuel_events_vehicle_detected_idx` ON `refuel_events` (`vehicle_id`,`detected_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `refuel_events_vehicle_detected_unique` ON `refuel_events` (`vehicle_id`,`detected_at`);