ALTER TABLE `engine_sessions` ADD `engine_temp_start` real;--> statement-breakpoint
ALTER TABLE `engine_sessions` ADD `engine_temp_end` real;--> statement-breakpoint
UPDATE `engine_sessions` SET `engine_temp_start` = (
	SELECT `engine_temp` FROM `vehicle_snapshots`
	WHERE `vehicle_snapshots`.`vehicle_id` = `engine_sessions`.`vehicle_id`
		AND `vehicle_snapshots`.`engine_temp` IS NOT NULL
		AND `vehicle_snapshots`.`ts` >= `engine_sessions`.`started_at`
		AND `vehicle_snapshots`.`ts` <= coalesce(`engine_sessions`.`ended_at`, `engine_sessions`.`started_at`) + 300000
	ORDER BY `vehicle_snapshots`.`ts` ASC LIMIT 1
) WHERE `engine_temp_start` IS NULL;--> statement-breakpoint
UPDATE `engine_sessions` SET `engine_temp_end` = (
	SELECT `engine_temp` FROM `vehicle_snapshots`
	WHERE `vehicle_snapshots`.`vehicle_id` = `engine_sessions`.`vehicle_id`
		AND `vehicle_snapshots`.`engine_temp` IS NOT NULL
		AND `vehicle_snapshots`.`ts` >= `engine_sessions`.`started_at`
		AND `vehicle_snapshots`.`ts` <= coalesce(`engine_sessions`.`ended_at`, `engine_sessions`.`started_at`) + 300000
	ORDER BY `vehicle_snapshots`.`ts` DESC LIMIT 1
) WHERE `engine_temp_end` IS NULL;
