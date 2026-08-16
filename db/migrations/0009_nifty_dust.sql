ALTER TABLE `refuel_events` ADD `sensor_litres_added` real;--> statement-breakpoint
UPDATE `refuel_events` SET `sensor_litres_added` = `litres_added` WHERE `litres_added` IS NOT NULL;