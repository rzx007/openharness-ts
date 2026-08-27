CREATE TABLE `attachment_asset` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `declared_media_type` text,
  `media_type` text,
  `size_bytes` integer,
  `sha256` text,
  `status` text NOT NULL,
  `staging_name` text,
  `failure_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `attachment_asset_hash_status_idx`
  ON `attachment_asset` (`sha256`, `status`);
--> statement-breakpoint
CREATE INDEX `attachment_asset_status_updated_idx`
  ON `attachment_asset` (`status`, `updated_at`);
