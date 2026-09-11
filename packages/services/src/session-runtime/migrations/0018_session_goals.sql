CREATE TABLE `session_goal` (`id` text PRIMARY KEY NOT NULL, `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE cascade, `objective` text NOT NULL, `revision` integer NOT NULL, `status` text NOT NULL, `max_auto_turns` integer NOT NULL, `auto_turns_used` integer NOT NULL, `no_progress_count` integer NOT NULL, `current_run_id` text, `reason` text, `wait_json` text, `evidence_json` text NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `session_goal_session_updated_idx` ON `session_goal` (`session_id`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_goal_session_open_unique` ON `session_goal` (`session_id`) WHERE `status` IN ('active','waiting_user','blocked','paused');
--> statement-breakpoint
CREATE TABLE `session_goal_request` (`request_id` text PRIMARY KEY NOT NULL, `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE cascade, `fingerprint` text NOT NULL, `status` text NOT NULL, `goal_id` text, `result_json` text, `error` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `session_goal_request_session_idx` ON `session_goal_request` (`session_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `session_goal_assessment` (`id` text PRIMARY KEY NOT NULL, `goal_id` text NOT NULL REFERENCES `session_goal`(`id`) ON DELETE cascade, `revision` integer NOT NULL, `run_id` text NOT NULL, `assessment_json` text NOT NULL, `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_goal_assessment_run_unique` ON `session_goal_assessment` (`goal_id`,`revision`,`run_id`);
--> statement-breakpoint
CREATE TABLE `session_goal_continuation` (`id` text PRIMARY KEY NOT NULL, `goal_id` text NOT NULL REFERENCES `session_goal`(`id`) ON DELETE cascade, `revision` integer NOT NULL, `previous_run_id` text NOT NULL, `input_id` text, `run_id` text, `status` text NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_goal_continuation_previous_unique` ON `session_goal_continuation` (`goal_id`,`revision`,`previous_run_id`);
