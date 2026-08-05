CREATE TABLE `api_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`endpoint` text NOT NULL,
	`status` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_calls_day_idx` ON `api_calls` (`day`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_ready_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `starline_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `starline_tokens_kind_unique` ON `starline_tokens` (`kind`);--> statement-breakpoint
CREATE TABLE `trips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vehicle_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`mileage_start` real,
	`mileage_end` real,
	`distance` real,
	`fuel_start` real,
	`fuel_end` real,
	`fuel_used` real,
	`lat_start` real,
	`lon_start` real,
	`lat_end` real,
	`lon_end` real,
	`is_open` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trips_vehicle_started_idx` ON `trips` (`vehicle_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`login` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`telegram_chat_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_unique` ON `users` (`login`);--> statement-breakpoint
CREATE TABLE `vehicle_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vehicle_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`activity_ts` integer,
	`ignition` integer,
	`mileage` real,
	`fuel` real,
	`battery` real,
	`engine_temp` real,
	`cabin_temp` real,
	`lat` real,
	`lon` real,
	`gsm_level` integer,
	`raw_json` text NOT NULL,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `snapshots_vehicle_ts_idx` ON `vehicle_snapshots` (`vehicle_id`,`ts`);--> statement-breakpoint
CREATE TABLE `vehicles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`alias` text DEFAULT 'Chery' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vehicles_device_id_unique` ON `vehicles` (`device_id`);