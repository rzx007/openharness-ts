CREATE TABLE `application_storage_format` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`version` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `application_storage_format` (`id`, `version`) VALUES (1, 1);
