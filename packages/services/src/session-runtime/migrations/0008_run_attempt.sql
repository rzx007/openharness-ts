CREATE TABLE `session_run_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	`provider` text,
	`model` text,
	`retry_reason` text,
	`error_kind` text,
	`error` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_run_attempt_run_sequence_unique` ON `session_run_attempt` (`run_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `session_run_attempt_run_idx` ON `session_run_attempt` (`run_id`);
--> statement-breakpoint
CREATE INDEX `session_run_attempt_status_idx` ON `session_run_attempt` (`status`);
