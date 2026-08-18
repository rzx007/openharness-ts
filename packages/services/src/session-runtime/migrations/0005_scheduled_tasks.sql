CREATE TABLE `scheduled_task` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `prompt` text NOT NULL,
  `recurrence` text NOT NULL,
  `recurrence_format` text NOT NULL,
  `timezone` text NOT NULL,
  `status` text NOT NULL,
  `destination` text NOT NULL,
  `session_id` text,
  `project_paths_json` text NOT NULL,
  `execution_mode` text NOT NULL,
  `model` text,
  `effort` text,
  `skill_names_json` text NOT NULL,
  `plugin_names_json` text NOT NULL,
  `permission_profile_json` text NOT NULL,
  `overlap_policy` text NOT NULL,
  `missed_run_policy` text NOT NULL,
  `stop_policy_json` text,
  `created_by` text NOT NULL,
  `created_from_session_id` text,
  `last_run_at` integer,
  `next_run_at` integer,
  `run_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_task_status_next_idx` ON `scheduled_task` (`status`,`next_run_at`);
--> statement-breakpoint
CREATE INDEX `scheduled_task_session_idx` ON `scheduled_task` (`session_id`);
--> statement-breakpoint
CREATE TABLE `scheduled_run` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `cause` text NOT NULL,
  `status` text NOT NULL,
  `scheduled_for` integer NOT NULL,
  `session_id` text,
  `run_id` text,
  `summary` text,
  `error` text,
  `unread` integer NOT NULL,
  `attention_reason` text,
  `created_at` integer NOT NULL,
  `started_at` integer,
  `finished_at` integer,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_run_task_created_idx` ON `scheduled_run` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `scheduled_run_status_idx` ON `scheduled_run` (`status`);
--> statement-breakpoint
CREATE INDEX `scheduled_run_unread_idx` ON `scheduled_run` (`unread`,`created_at`);
