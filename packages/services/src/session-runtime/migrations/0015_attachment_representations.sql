CREATE TABLE `attachment_representation` (
  `id` text PRIMARY KEY NOT NULL,
  `asset_id` text NOT NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `processor` text NOT NULL,
  `processor_version` text NOT NULL,
  `cache_key` text NOT NULL,
  `media_type` text NOT NULL,
  `text` text,
  `error` text,
  `metadata_json` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`asset_id`) REFERENCES `attachment_asset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_representation_asset_kind_cache_unique`
  ON `attachment_representation` (`asset_id`, `kind`, `cache_key`);
--> statement-breakpoint
CREATE INDEX `attachment_representation_asset_idx`
  ON `attachment_representation` (`asset_id`, `created_at`);
