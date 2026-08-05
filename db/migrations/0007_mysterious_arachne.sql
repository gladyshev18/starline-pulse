CREATE TABLE `telegram_recipients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`chat_id` text NOT NULL,
	`first_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_recipients_username_unique` ON `telegram_recipients` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_recipients_chat_id_unique` ON `telegram_recipients` (`chat_id`);