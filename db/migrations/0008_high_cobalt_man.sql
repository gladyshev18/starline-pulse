CREATE TABLE `imap_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mailbox` text NOT NULL,
	`uid_validity` text,
	`last_uid` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_state_mailbox_unique` ON `imap_state` (`mailbox`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_refuel_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refuel_event_id` integer,
	`suggested_refuel_event_id` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`data_source` text DEFAULT 'manual' NOT NULL,
	`match_status` text DEFAULT 'unmatched' NOT NULL,
	`match_score` real,
	`matched_at` integer,
	`payment_method` text DEFAULT 'unknown' NOT NULL,
	`purchased_at` integer,
	`station` text,
	`station_name` text,
	`address` text,
	`fuel_type` text,
	`litres` real,
	`price_per_litre` real,
	`total_amount` real,
	`fiscal_doc_number` text,
	`fiscal_sign` text,
	`seller_inn` text,
	`original_name` text,
	`stored_name` text,
	`mime_type` text,
	`size` integer,
	`content_hash` text,
	`external_message_id` text,
	`pending_field` text,
	`pending_chat_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`refuel_event_id`) REFERENCES `refuel_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`suggested_refuel_event_id`) REFERENCES `refuel_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_refuel_receipts`("id", "refuel_event_id", "source", "data_source", "match_status", "matched_at", "payment_method", "original_name", "stored_name", "mime_type", "size", "external_message_id", "created_at", "updated_at") SELECT "id", "refuel_event_id", "source", 'manual', 'manual', "created_at", 'unknown', "original_name", "stored_name", "mime_type", "size", "external_message_id", "created_at", "created_at" FROM `refuel_receipts`;--> statement-breakpoint
DROP TABLE `refuel_receipts`;--> statement-breakpoint
ALTER TABLE `__new_refuel_receipts` RENAME TO `refuel_receipts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `refuel_receipts_refuel_event_idx` ON `refuel_receipts` (`refuel_event_id`);--> statement-breakpoint
CREATE INDEX `refuel_receipts_match_status_idx` ON `refuel_receipts` (`match_status`);--> statement-breakpoint
CREATE INDEX `refuel_receipts_purchased_at_idx` ON `refuel_receipts` (`purchased_at`);--> statement-breakpoint
CREATE INDEX `refuel_receipts_content_hash_idx` ON `refuel_receipts` (`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `refuel_receipts_stored_name_unique` ON `refuel_receipts` (`stored_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `refuel_receipts_external_message_id_unique` ON `refuel_receipts` (`external_message_id`);