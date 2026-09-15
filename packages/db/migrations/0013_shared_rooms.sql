-- 0013: a Room's owner can publish its log at a public, read-only link.
-- The link's slug is its own bearer token, never the Room id, because the
-- Room id is the capability to join (identity model §8) and a reader of the
-- public page must not be able to walk in. Expand-only: two nullable
-- columns, set together and cleared together.
ALTER TABLE "sharednet"."room" ADD COLUMN "share_token" text;
--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD COLUMN "shared_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD CONSTRAINT "room_share_token_unique" UNIQUE("share_token");
--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD CONSTRAINT "room_share_consistent" CHECK (("share_token" IS NULL AND "shared_at" IS NULL)
          OR ("share_token" IS NOT NULL AND "shared_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD CONSTRAINT "room_share_token_format" CHECK ("share_token" IS NULL OR "share_token" ~ '^shr_[A-Za-z0-9_-]{43}$');
