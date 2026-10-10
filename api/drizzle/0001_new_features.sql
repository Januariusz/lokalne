CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text(64) NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notification_user` ON `notification` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `promotion_offer` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`offered_by` text,
	`target_role` text DEFAULT 'reviewer' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`responded_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offered_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_promotion_user` ON `promotion_offer` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `review_comment` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text(2000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `review`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_review_comment_review` ON `review_comment` (`review_id`);--> statement-breakpoint
CREATE INDEX `idx_review_comment_author` ON `review_comment` (`author_id`);--> statement-breakpoint
CREATE TABLE `review_like` (
	`user_id` text NOT NULL,
	`review_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`user_id`, `review_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `review`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_like_review` ON `review_like` (`review_id`);--> statement-breakpoint
CREATE TABLE `user_ban` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`banned_by` text,
	`reason` text(500) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`banned_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`revoked_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_user_ban_user` ON `user_ban` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_ban_created` ON `user_ban` (`created_at`);--> statement-breakpoint
CREATE TABLE `visit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`visited_at` integer DEFAULT (unixepoch()) NOT NULL,
	`visitor_hash` text(32) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_visit_log_at` ON `visit_log` (`visited_at`);--> statement-breakpoint
ALTER TABLE `camera` ADD `variable_aperture` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `camera` ADD `aperture_narrow` real;--> statement-breakpoint
ALTER TABLE `camera` ADD `optical_zoom` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `camera` ADD `focal_length_max_mm` real;