CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`issuer` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_issuer_account_id` ON `account` (`issuer`,`account_id`);--> statement-breakpoint
CREATE TABLE `brand` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text(128) NOT NULL,
	`logo_url` text(512)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brand_name_unique` ON `brand` (`name`);--> statement-breakpoint
CREATE TABLE `camera` (
	`id` text PRIMARY KEY NOT NULL,
	`smartphone_id` text NOT NULL,
	`submitter_id` text NOT NULL,
	`reviewed_by` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`submitted_at` integer DEFAULT (unixepoch()) NOT NULL,
	`reviewed_at` integer,
	`type` text NOT NULL,
	`facing` text DEFAULT 'back' NOT NULL,
	`focal_length_mm` real NOT NULL,
	`aperture` real NOT NULL,
	`crop_factor` real NOT NULL,
	`pixel_pitch_um` real NOT NULL,
	`resolution_mp` real NOT NULL,
	`active_resolution_mp` real NOT NULL,
	`af_zones` integer DEFAULT 0 NOT NULL,
	`ois` text DEFAULT 'none' NOT NULL,
	FOREIGN KEY (`smartphone_id`) REFERENCES `smartphone`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_camera_smartphone` ON `camera` (`smartphone_id`);--> statement-breakpoint
CREATE INDEX `idx_camera_submitter` ON `camera` (`submitter_id`);--> statement-breakpoint
CREATE INDEX `idx_camera_status` ON `camera` (`status`);--> statement-breakpoint
CREATE TABLE `camera_video_mode` (
	`id` text PRIMARY KEY NOT NULL,
	`camera_id` text NOT NULL,
	`width_px` integer NOT NULL,
	`height_px` integer NOT NULL,
	`fps_max` real NOT NULL,
	`note` text(128),
	FOREIGN KEY (`camera_id`) REFERENCES `camera`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_video_mode_camera` ON `camera_video_mode` (`camera_id`);--> statement-breakpoint
CREATE TABLE `favorite` (
	`user_id` text NOT NULL,
	`smartphone_id` text NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`user_id`, `smartphone_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`smartphone_id`) REFERENCES `smartphone`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`alg` text,
	`crv` text
);
--> statement-breakpoint
CREATE TABLE `photo` (
	`id` text PRIMARY KEY NOT NULL,
	`uploader_id` text NOT NULL,
	`camera_id` text NOT NULL,
	`storage_url` text(512) NOT NULL,
	`exif_focal_length` real,
	`exif_aperture` real,
	`exif_iso` integer,
	`exif_shutter_speed` real,
	`width_px` integer NOT NULL,
	`height_px` integer NOT NULL,
	`upload_date` integer DEFAULT (unixepoch()) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`uploader_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`camera_id`) REFERENCES `camera`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_photo_camera` ON `photo` (`camera_id`);--> statement-breakpoint
CREATE INDEX `idx_photo_uploader` ON `photo` (`uploader_id`);--> statement-breakpoint
CREATE TABLE `review` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`smartphone_id` text NOT NULL,
	`title` text(256) NOT NULL,
	`content_markdown` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`smartphone_id`) REFERENCES `smartphone`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_author` ON `review` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_review_smartphone` ON `review` (`smartphone_id`);--> statement-breakpoint
CREATE TABLE `review_media` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`type` text NOT NULL,
	`storage_url` text(512) NOT NULL,
	`display_order` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `review`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_media_review` ON `review_media` (`review_id`);--> statement-breakpoint
CREATE TABLE `role_change_log` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`previous_role` text NOT NULL,
	`new_role` text NOT NULL,
	`changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`changed_by` text,
	FOREIGN KEY (`target_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`changed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_role_log_target` ON `role_change_log` (`target_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `smartphone` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`added_by` text NOT NULL,
	`verified_by` text,
	`model_name` text(128) NOT NULL,
	`image_url` text(512),
	`release_date` text,
	`view_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brand`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`verified_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_smartphone_brand` ON `smartphone` (`brand_id`);--> statement-breakpoint
CREATE INDEX `idx_smartphone_added_by` ON `smartphone` (`added_by`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`username` text,
	`role` text DEFAULT 'user' NOT NULL,
	`is_deleted_user` integer DEFAULT false NOT NULL,
	`password_reset_token` text,
	`reset_token_expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE `video` (
	`id` text PRIMARY KEY NOT NULL,
	`uploader_id` text NOT NULL,
	`camera_id` text NOT NULL,
	`storage_url` text(512) NOT NULL,
	`width_px` integer NOT NULL,
	`height_px` integer NOT NULL,
	`fps` real NOT NULL,
	`upload_date` integer DEFAULT (unixepoch()) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`uploader_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`camera_id`) REFERENCES `camera`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_video_camera` ON `video` (`camera_id`);--> statement-breakpoint
CREATE INDEX `idx_video_uploader` ON `video` (`uploader_id`);