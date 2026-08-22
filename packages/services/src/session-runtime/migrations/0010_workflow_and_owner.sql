CREATE TABLE `workflow_run` (
	`run_id` text PRIMARY KEY NOT NULL,
	`owner_session_id` text,
	`owner_input_id` text,
	`owner_run_id` text,
	`status` text NOT NULL,
	`termination` text,
	`snapshot_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_input_id`) REFERENCES `session_input`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_run_id`) REFERENCES `session_run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_run_owner_idx` ON `workflow_run` (`owner_session_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `workflow_run_status_idx` ON `workflow_run` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `workflow_task_attempt` (
	`workflow_run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY (`workflow_run_id`,`task_id`,`attempt`),
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workflow_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_run_id` text NOT NULL,
	`type` text NOT NULL,
	`event_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_event_run_seq_idx` ON `workflow_event` (`workflow_run_id`,`seq`);
--> statement-breakpoint
CREATE TABLE `workflow_execution_claim` (
	`workflow_run_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`generation` integer NOT NULL,
	`claimed_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_owner` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`pid` integer NOT NULL,
	`generation` integer NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `retention_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`policy` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer NOT NULL
);
