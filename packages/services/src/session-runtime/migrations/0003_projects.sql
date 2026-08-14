CREATE TABLE `project` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `pinned_at` integer,
  `last_opened_at` integer NOT NULL,
  `archived_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_location` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `path` text NOT NULL,
  `normalized_path` text NOT NULL,
  `status` text NOT NULL,
  `bound_at` integer NOT NULL,
  `last_verified_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_location_active_project` ON `project_location` (`project_id`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX `project_location_active_path` ON `project_location` (`normalized_path`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE INDEX `project_location_project_idx` ON `project_location` (`project_id`, `status`);
--> statement-breakpoint
ALTER TABLE `session` ADD `project_id` text REFERENCES project(id);
--> statement-breakpoint
ALTER TABLE `session` ADD `cwd_relative` text;
