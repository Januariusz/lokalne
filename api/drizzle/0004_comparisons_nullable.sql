CREATE TABLE `review_smartphone` (
	`review_id` text NOT NULL,
	`smartphone_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`review_id`, `smartphone_id`),
	FOREIGN KEY (`review_id`) REFERENCES `review`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`smartphone_id`) REFERENCES `smartphone`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_smartphone_phone` ON `review_smartphone` (`smartphone_id`);--> statement-breakpoint
-- camera.af_zones i camera.ois mogą być NULL (= nieznane). Bez przebudowy tabeli camera:
-- DROP TABLE camera w transakcji migracji łamałby klucze obce (zdjęcia, filmy, tryby wideo).
ALTER TABLE `camera` ADD COLUMN `af_zones_nullable` integer;--> statement-breakpoint
UPDATE `camera` SET `af_zones_nullable` = `af_zones`;--> statement-breakpoint
ALTER TABLE `camera` DROP COLUMN `af_zones`;--> statement-breakpoint
ALTER TABLE `camera` RENAME COLUMN `af_zones_nullable` TO `af_zones`;--> statement-breakpoint
ALTER TABLE `camera` ADD COLUMN `ois_nullable` text;--> statement-breakpoint
UPDATE `camera` SET `ois_nullable` = `ois`;--> statement-breakpoint
ALTER TABLE `camera` DROP COLUMN `ois`;--> statement-breakpoint
ALTER TABLE `camera` RENAME COLUMN `ois_nullable` TO `ois`;
