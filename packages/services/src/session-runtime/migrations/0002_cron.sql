CREATE TABLE `cron_job` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`expression` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`timezone` text,
	`enabled` integer NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cron_job_name_unique` ON `cron_job` (`name`);
--> statement-breakpoint
CREATE INDEX `cron_job_enabled_next_idx` ON `cron_job` (`enabled`,`next_run_at`);
--> statement-breakpoint
CREATE TABLE `cron_run` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`job_name` text NOT NULL,
	`cause` text NOT NULL,
	`status` text NOT NULL,
	`output` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `cron_run_job_started_idx` ON `cron_run` (`job_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `cron_run_status_idx` ON `cron_run` (`status`);
