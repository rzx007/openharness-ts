CREATE TABLE `session_input_attachment` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `input_id` text NOT NULL,
  `asset_id` text NOT NULL,
  `seq` integer NOT NULL,
  `intent` text NOT NULL,
  `display_name` text NOT NULL,
  `media_type` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `metadata_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`input_id`) REFERENCES `session_input`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`asset_id`) REFERENCES `attachment_asset`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `session_input_attachment_input_seq_unique` UNIQUE(`input_id`, `seq`),
  CONSTRAINT `session_input_attachment_input_asset_unique` UNIQUE(`input_id`, `asset_id`)
);
--> statement-breakpoint
CREATE INDEX `session_input_attachment_input_seq_idx`
  ON `session_input_attachment` (`input_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `session_input_attachment_asset_idx`
  ON `session_input_attachment` (`asset_id`);
--> statement-breakpoint
CREATE INDEX `session_input_attachment_session_idx`
  ON `session_input_attachment` (`session_id`);
--> statement-breakpoint
ALTER TABLE `session_message_part` ADD `asset_id` text;
--> statement-breakpoint
ALTER TABLE `session_message_part` ADD `attachment_intent` text;
--> statement-breakpoint
ALTER TABLE `session_message_part` ADD `display_name` text;
--> statement-breakpoint
ALTER TABLE `session_message_part` ADD `media_type` text;
--> statement-breakpoint
ALTER TABLE `session_message_part` ADD `size_bytes` integer;
--> statement-breakpoint
ALTER TABLE `session_message_part` ADD `transformation_kind` text;
--> statement-breakpoint
ALTER TABLE `session_message_part` ADD `representation_id` text;
--> statement-breakpoint
ALTER TABLE `session_message_part` ADD `processor` text;
--> statement-breakpoint
ALTER TABLE `session_message_part` ADD `transformation_error` text;
