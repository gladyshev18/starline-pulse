CREATE TABLE `refuel_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refuel_event_id` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`original_name` text NOT NULL,
	`stored_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`external_message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`refuel_event_id`) REFERENCES `refuel_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `refuel_receipts_refuel_event_idx` ON `refuel_receipts` (`refuel_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refuel_receipts_stored_name_unique` ON `refuel_receipts` (`stored_name`);