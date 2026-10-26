ALTER TABLE `camera` ADD `sensor_format` text(16);--> statement-breakpoint
ALTER TABLE `camera` ADD `photo_width_px` integer;--> statement-breakpoint
ALTER TABLE `camera` ADD `photo_height_px` integer;--> statement-breakpoint
ALTER TABLE `camera` ADD `aspect_ratio` text(16);--> statement-breakpoint
ALTER TABLE `camera` ADD `note` text(500);