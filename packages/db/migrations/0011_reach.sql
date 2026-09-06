-- 0011: reach, public or private, on the Instance; forming a group.
-- docs/decisions/2026-09-06-reach-public-or-private.md
-- Expand-only. reach defaults to public on every existing Instance and
-- Principal; a seat may now be admitted by being added (public) or by
-- accepting a request (private), recording who asked; a Decision may be asked
-- by another Principal's Instance about another Principal's Room, so the two
-- composite keys that tied both to the deciding Principal become plain keys.
ALTER TABLE "sharednet"."principal" ADD COLUMN "default_reach" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."principal" ADD CONSTRAINT "principal_default_reach_valid" CHECK ("sharednet"."principal"."default_reach" IN ('public', 'private'));--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD COLUMN "reach" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_reach_valid" CHECK ("sharednet"."instance"."reach" IN ('public', 'private'));--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD COLUMN "added_by_instance_id" text;--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" DROP CONSTRAINT "room_member_admitted_by_valid";--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_admitted_by_valid" CHECK ("sharednet"."room_member"."admitted_by" IN ('room_id', 'invite', 'added', 'accepted'));--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_added_by_consistent" CHECK (("sharednet"."room_member"."admitted_by" IN ('added', 'accepted')) = ("sharednet"."room_member"."added_by_instance_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_added_by_instance_fk" FOREIGN KEY ("added_by_instance_id") REFERENCES "sharednet"."instance"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD COLUMN "requested_for_instance_id" text;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" DROP CONSTRAINT "decision_requester_instance_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_requester_instance_fk" FOREIGN KEY ("requested_by_instance_id") REFERENCES "sharednet"."instance"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_requested_for_instance_fk" FOREIGN KEY ("requested_for_instance_id") REFERENCES "sharednet"."instance"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" DROP CONSTRAINT "decision_room_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_room_fk" FOREIGN KEY ("room_id") REFERENCES "sharednet"."room"("id") ON DELETE no action ON UPDATE no action;
