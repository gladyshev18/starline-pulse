CREATE TABLE `service_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_event_id` integer,
	`kind` text DEFAULT 'unknown' NOT NULL,
	`source` text DEFAULT 'telegram' NOT NULL,
	`received_at` integer NOT NULL,
	`performed_at` integer,
	`vendor` text,
	`total_amount` real,
	`mileage` real,
	`note` text,
	`parsed_at` integer,
	`original_name` text,
	`stored_name` text,
	`mime_type` text,
	`size` integer,
	`content_hash` text,
	`pending_chat_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_event_id`) REFERENCES `service_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `service_documents_kind_idx` ON `service_documents` (`kind`,`received_at`);--> statement-breakpoint
CREATE INDEX `service_documents_content_hash_idx` ON `service_documents` (`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_documents_stored_name_unique` ON `service_documents` (`stored_name`);