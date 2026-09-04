ALTER TABLE "sharednet_auth"."apikey" DROP CONSTRAINT "auth_apikey_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."agent" DROP CONSTRAINT "agent_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."decision" DROP CONSTRAINT "decision_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."idempotency_record" DROP CONSTRAINT "idempotency_actor_id_valid";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" DROP CONSTRAINT "instance_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" DROP CONSTRAINT "instance_issued_by_key_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."message" DROP CONSTRAINT "message_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."principal" DROP CONSTRAINT "principal_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" DROP CONSTRAINT "room_member_room_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" DROP CONSTRAINT "room_member_agent_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."room" DROP CONSTRAINT "room_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD COLUMN "runtime_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD COLUMN "instance_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_instance_fk" FOREIGN KEY ("principal_id","instance_id") REFERENCES "sharednet"."instance"("principal_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_member_instance_idx" ON "sharednet"."room_member" USING btree ("instance_id");--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" DROP CONSTRAINT "room_member_pk";
--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_pk" PRIMARY KEY("room_id","instance_id");--> statement-breakpoint
ALTER TABLE "sharednet_auth"."apikey" ADD CONSTRAINT "auth_apikey_id_format" CHECK ("sharednet_auth"."apikey"."id" ~ '^key_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."agent" ADD CONSTRAINT "agent_id_format" CHECK ("sharednet"."agent"."id" ~ '^a_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_id_format" CHECK ("sharednet"."decision"."id" ~ '^dec_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."idempotency_record" ADD CONSTRAINT "idempotency_actor_id_valid" CHECK (("sharednet"."idempotency_record"."credential_class" = 'web_session' AND length("sharednet"."idempotency_record"."actor_id") > 0)
          OR ("sharednet"."idempotency_record"."credential_class" = 'api_key' AND "sharednet"."idempotency_record"."actor_id" ~ '^key_[0-9A-Za-z]{10}$')
          OR ("sharednet"."idempotency_record"."credential_class" = 'instance' AND "sharednet"."idempotency_record"."actor_id" ~ '^i_[0-9A-Za-z]{10}$'));--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_id_format" CHECK ("sharednet"."instance"."id" ~ '^i_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_issued_by_key_id_format" CHECK ("sharednet"."instance"."issued_by_key_id" ~ '^key_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_id_format" CHECK ("sharednet"."message"."id" ~ '^msg_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."principal" ADD CONSTRAINT "principal_id_format" CHECK ("sharednet"."principal"."id" ~ '^p_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_instance_id_format" CHECK ("sharednet"."room_member"."instance_id" ~ '^i_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_room_id_format" CHECK ("sharednet"."room_member"."room_id" ~ '^rom_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_agent_id_format" CHECK ("sharednet"."room_member"."agent_id" ~ '^a_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD CONSTRAINT "room_id_format" CHECK ("sharednet"."room"."id" ~ '^rom_[0-9A-Za-z]{10}$');