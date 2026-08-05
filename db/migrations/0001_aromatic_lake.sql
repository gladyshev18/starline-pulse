ALTER TABLE `api_calls` ADD `method` text DEFAULT 'GET' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_calls` ADD `url` text;--> statement-breakpoint
ALTER TABLE `api_calls` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `api_calls` ADD `request_headers` text;--> statement-breakpoint
ALTER TABLE `api_calls` ADD `request_body` text;--> statement-breakpoint
ALTER TABLE `api_calls` ADD `response_headers` text;--> statement-breakpoint
ALTER TABLE `api_calls` ADD `response_body` text;--> statement-breakpoint
ALTER TABLE `api_calls` ADD `error` text;--> statement-breakpoint
CREATE INDEX `api_calls_created_at_idx` ON `api_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `api_calls_status_idx` ON `api_calls` (`status`);