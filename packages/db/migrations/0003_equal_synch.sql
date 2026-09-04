-- Reordered by hand: drizzle-kit dropped instance_principal_agent_id_unique
-- before the two foreign keys that reference it, which PostgreSQL rejects.
ALTER TABLE "sharednet"."agent" DROP CONSTRAINT "agent_default_handle_consistent";--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" DROP CONSTRAINT "room_member_agent_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."decision" DROP CONSTRAINT "decision_requester_agent_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."decision" DROP CONSTRAINT "decision_requester_instance_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" DROP CONSTRAINT "instance_principal_agent_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."message" DROP CONSTRAINT "message_sender_agent_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."message" DROP CONSTRAINT "message_sender_instance_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" DROP CONSTRAINT "instance_principal_agent_id_unique";--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" DROP CONSTRAINT "room_member_agent_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."room" DROP CONSTRAINT "room_creator_agent_fk";--> statement-breakpoint
DROP INDEX "sharednet"."agent_one_default_per_principal";--> statement-breakpoint
DROP INDEX "sharednet"."room_member_principal_agent_idx";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD COLUMN "local_instance_key" text;--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD COLUMN "creator_instance_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_requester_instance_fk" FOREIGN KEY ("principal_id","requested_by_instance_id") REFERENCES "sharednet"."instance"("principal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_principal_agent_fk" FOREIGN KEY ("principal_id","agent_id") REFERENCES "sharednet"."agent"("principal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_sender_instance_fk" FOREIGN KEY ("sender_principal_id","sender_instance_id") REFERENCES "sharednet"."instance"("principal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD CONSTRAINT "room_creator_instance_fk" FOREIGN KEY ("principal_id","creator_instance_id") REFERENCES "sharednet"."instance"("principal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instance_principal_active_local_key_unique" ON "sharednet"."instance" USING btree ("principal_id","local_instance_key") WHERE "sharednet"."instance"."state" = 'active' AND "sharednet"."instance"."local_instance_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "room_member_principal_idx" ON "sharednet"."room_member" USING btree ("principal_id");--> statement-breakpoint
ALTER TABLE "sharednet"."agent" DROP COLUMN "is_default";--> statement-breakpoint
ALTER TABLE "sharednet"."decision" DROP COLUMN "requested_by_agent_id";--> statement-breakpoint
ALTER TABLE "sharednet"."message" DROP COLUMN "sender_agent_id";--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "sharednet"."room" DROP COLUMN "creator_agent_id";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_local_instance_key_format" CHECK ("sharednet"."instance"."local_instance_key" IS NULL OR "sharednet"."instance"."local_instance_key" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD CONSTRAINT "room_creator_instance_id_format" CHECK ("sharednet"."room"."creator_instance_id" ~ '^i_[0-9A-Za-z]{10}$');
