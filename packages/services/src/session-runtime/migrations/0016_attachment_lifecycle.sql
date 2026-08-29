CREATE TABLE `attachment_lease` (
  `id` text PRIMARY KEY NOT NULL,
  `asset_id` text NOT NULL,
  `owner_kind` text NOT NULL,
  `owner_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `renewed_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  FOREIGN KEY (`asset_id`) REFERENCES `attachment_asset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_lease_asset_owner_unique`
  ON `attachment_lease` (`asset_id`, `owner_kind`, `owner_id`);
--> statement-breakpoint
CREATE INDEX `attachment_lease_expiry_idx`
  ON `attachment_lease` (`expires_at`, `asset_id`);
