-- 0016: one kind of file. `reach` had three values and two dependent checks;
-- the owner's ask was "upload, download, a link" and that is one thing. Every
-- artifact now has a link key, and `room_id` is the separate, optional fact
-- that a Room's members may also read it by id.
-- The old checks come off first: one of them forbids a link key on a file
-- whose reach was not `link`, so the backfill below cannot run while it stands.
ALTER TABLE "sharednet"."artifact" DROP CONSTRAINT IF EXISTS "artifact_reach_known";
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact" DROP CONSTRAINT IF EXISTS "artifact_room_reach_has_a_room";
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact" DROP CONSTRAINT IF EXISTS "artifact_link_reach_has_a_key";
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact" DROP CONSTRAINT IF EXISTS "artifact_link_key_format";
--> statement-breakpoint
UPDATE "sharednet"."artifact"
SET "link_key" = 'afk_' || substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 43)
WHERE "link_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact" ALTER COLUMN "link_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact" ADD CONSTRAINT "artifact_link_key_format" CHECK ("sharednet"."artifact"."link_key" ~ '^afk_[A-Za-z0-9_-]{43}$');
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact" DROP COLUMN "reach";
