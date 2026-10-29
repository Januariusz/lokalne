CREATE TABLE `smartphone_build_model` (
	`build_model_key` text(128) PRIMARY KEY NOT NULL,
	`build_model` text(128) NOT NULL,
	`smartphone_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`smartphone_id`) REFERENCES `smartphone`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_build_model_smartphone` ON `smartphone_build_model` (`smartphone_id`);--> statement-breakpoint
ALTER TABLE `camera` ADD `sensor_denominator` real;--> statement-breakpoint
CREATE INDEX `idx_camera_phone_status` ON `camera` (`smartphone_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_photo_camera_status_date` ON `photo` (`camera_id`,`status`,"upload_date" DESC);--> statement-breakpoint
CREATE INDEX `idx_review_phone_status_upd` ON `review` (`smartphone_id`,`status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_review_author_upd` ON `review` (`author_id`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_smartphone_name_nocase` ON `smartphone` ("model_name" COLLATE NOCASE,`id`);--> statement-breakpoint
CREATE INDEX `idx_smartphone_trending` ON `smartphone` ("view_count" DESC,"created_at" DESC,`id`);--> statement-breakpoint
CREATE INDEX `idx_smartphone_new` ON `smartphone` ("release_date" DESC,"created_at" DESC,`id`);--> statement-breakpoint
CREATE INDEX `idx_video_camera_status_date` ON `video` (`camera_id`,`status`,"upload_date" DESC);