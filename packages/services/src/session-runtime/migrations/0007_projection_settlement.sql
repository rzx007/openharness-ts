CREATE TABLE `projection_settlement` (
	`id` text PRIMARY KEY NOT NULL,
	`projector` text NOT NULL,
	`root_session_id` text NOT NULL,
	`event_sequence` integer NOT NULL,
	`action` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_retry_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projection_settlement_event_idx` ON `projection_settlement` (`projector`,`root_session_id`,`event_sequence`);
--> statement-breakpoint
CREATE INDEX `projection_settlement_status_retry_idx` ON `projection_settlement` (`status`,`next_retry_at`);
