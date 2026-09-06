-- 0009: sharednet login.
-- docs/decisions/2026-09-06-every-member-is-an-instance.md §3
--
-- A CLI login is a device-style approval: the CLI starts one, the human
-- approves it in the Web, the CLI polls and receives an API key minted at that
-- moment. The approval may bind anonymous Principals whose seats the CLI
-- proved it holds; binding re-points their Instances to the account's
-- Principal, and every row that names an Instance's Principal follows by
-- cascade, so history is never rewritten by hand.
CREATE TABLE "sharednet"."cli_login" (
	"id" text PRIMARY KEY NOT NULL,
	"code_digest" text NOT NULL,
	"poll_token_digest" text NOT NULL,
	"label" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"bind_instance_ids" text[] DEFAULT '{}' NOT NULL,
	"principal_id" text,
	"api_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "cli_login_code_digest_unique" UNIQUE("code_digest"),
	CONSTRAINT "cli_login_poll_token_digest_unique" UNIQUE("poll_token_digest"),
	CONSTRAINT "cli_login_id_format" CHECK ("sharednet"."cli_login"."id" ~ '^cli_[0-9A-Za-z]{10}$'),
	CONSTRAINT "cli_login_code_digest_format" CHECK ("sharednet"."cli_login"."code_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cli_login_poll_token_digest_format" CHECK ("sharednet"."cli_login"."poll_token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cli_login_state_valid" CHECK ("sharednet"."cli_login"."state" IN ('pending', 'approved', 'consumed', 'denied', 'expired')),
	CONSTRAINT "cli_login_label_length" CHECK ("sharednet"."cli_login"."label" IS NULL OR length("sharednet"."cli_login"."label") BETWEEN 1 AND 120),
	CONSTRAINT "cli_login_approved_has_principal" CHECK ("sharednet"."cli_login"."state" NOT IN ('approved', 'consumed') OR "sharednet"."cli_login"."principal_id" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "sharednet"."cli_login" ADD CONSTRAINT "cli_login_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cli_login_expires_at_idx" ON "sharednet"."cli_login" USING btree ("expires_at");--> statement-breakpoint
-- Binding moves an Instance to another Principal; the rows that carry the
-- Instance's Principal beside its id follow automatically.
ALTER TABLE "sharednet"."room_member" DROP CONSTRAINT "room_member_instance_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_instance_fk" FOREIGN KEY ("principal_id","instance_id") REFERENCES "sharednet"."instance"("principal_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sharednet"."message" DROP CONSTRAINT "message_sender_instance_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_sender_instance_fk" FOREIGN KEY ("sender_principal_id","sender_instance_id") REFERENCES "sharednet"."instance"("principal_id","id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sharednet"."room" DROP CONSTRAINT "room_creator_instance_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD CONSTRAINT "room_creator_instance_fk" FOREIGN KEY ("principal_id","creator_instance_id") REFERENCES "sharednet"."instance"("principal_id","id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" DROP CONSTRAINT "decision_requester_instance_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_requester_instance_fk" FOREIGN KEY ("principal_id","requested_by_instance_id") REFERENCES "sharednet"."instance"("principal_id","id") ON DELETE no action ON UPDATE cascade;
