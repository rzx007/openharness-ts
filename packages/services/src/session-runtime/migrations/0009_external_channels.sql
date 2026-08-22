CREATE TABLE `external_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`connector` text NOT NULL,
	`account_id` text NOT NULL,
	`workspace_id` text,
	`chat_id` text NOT NULL,
	`thread_id` text NOT NULL DEFAULT '',
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_conversation_identity_unique` ON `external_conversation` (`connector`,`account_id`,`chat_id`,`thread_id`);
--> statement-breakpoint
CREATE INDEX `external_conversation_session_idx` ON `external_conversation` (`session_id`);
--> statement-breakpoint
CREATE TABLE `channel_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`connector` text NOT NULL,
	`account_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`thread_id` text NOT NULL DEFAULT '',
	`session_id` text NOT NULL,
	`input_id` text NOT NULL,
	`run_id` text NOT NULL,
	`external_message_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer NOT NULL DEFAULT 0,
	`external_delivery_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `external_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`input_id`) REFERENCES `session_input`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `session_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_delivery_input_unique` ON `channel_delivery` (`input_id`);
--> statement-breakpoint
CREATE INDEX `channel_delivery_status_idx` ON `channel_delivery` (`status`,`updated_at`);
