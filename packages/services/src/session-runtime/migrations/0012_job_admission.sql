ALTER TABLE `session_task` ADD `request_namespace` text;
--> statement-breakpoint
ALTER TABLE `session_task` ADD `request_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `session_task_request_identity_idx`
  ON `session_task` (`session_id`, `request_namespace`, `request_id`);
