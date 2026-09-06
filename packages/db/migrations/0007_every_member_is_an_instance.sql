-- 0007: every member is an Instance of a Principal.
-- docs/decisions/2026-09-06-every-member-is-an-instance.md
--
-- Expand-only. A Principal may now exist without an account behind it (an
-- anonymous Principal, provisioned by an invite join, bindable later); an
-- Instance may be admitted by an invite instead of issued by an API key, and
-- such an Instance's token has no expiry. Membership records how it was
-- admitted. Every existing guest becomes an anonymous Principal with one
-- Instance and one membership, and its messages move to that Instance; the
-- room_guest table is left in place, unread, for a later migration to drop.
ALTER TABLE "sharednet"."principal" ALTER COLUMN "auth_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."principal" ADD COLUMN "invited_by_principal_id" text;--> statement-breakpoint
ALTER TABLE "sharednet"."principal" ADD COLUMN "merged_into_principal_id" text;--> statement-breakpoint
ALTER TABLE "sharednet"."principal" ADD CONSTRAINT "principal_invited_by_fk" FOREIGN KEY ("invited_by_principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."principal" ADD CONSTRAINT "principal_merged_into_fk" FOREIGN KEY ("merged_into_principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."principal" ADD CONSTRAINT "principal_bound_or_invited" CHECK ("sharednet"."principal"."auth_user_id" IS NOT NULL OR "sharednet"."principal"."invited_by_principal_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ALTER COLUMN "issued_by_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ALTER COLUMN "token_expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD COLUMN "admitted_by_invite_id" text;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" DROP CONSTRAINT "instance_issued_by_key_id_format";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_issued_by_key_id_format" CHECK ("sharednet"."instance"."issued_by_key_id" IS NULL OR "sharednet"."instance"."issued_by_key_id" ~ '^key_[0-9A-Za-z]{10}$');--> statement-breakpoint
ALTER TABLE "sharednet"."instance" DROP CONSTRAINT "instance_time_order_valid";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_time_order_valid" CHECK ("sharednet"."instance"."last_seen_at" >= "sharednet"."instance"."started_at"
          AND "sharednet"."instance"."lease_expires_at" > "sharednet"."instance"."last_seen_at"
          AND ("sharednet"."instance"."token_expires_at" IS NULL OR "sharednet"."instance"."token_expires_at" > "sharednet"."instance"."started_at"));--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_issued_or_admitted" CHECK ("sharednet"."instance"."issued_by_key_id" IS NOT NULL OR "sharednet"."instance"."admitted_by_invite_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_display_name_length" CHECK ("sharednet"."instance"."display_name" IS NULL OR length("sharednet"."instance"."display_name") BETWEEN 1 AND 64);--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_admitted_by_invite_fk" FOREIGN KEY ("admitted_by_invite_id") REFERENCES "sharednet"."room_invite"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD COLUMN "admitted_by" text DEFAULT 'room_id' NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD COLUMN "invite_id" text;--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_admitted_by_valid" CHECK ("sharednet"."room_member"."admitted_by" IN ('room_id', 'invite'));--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_admitted_by_invite_consistent" CHECK (("sharednet"."room_member"."admitted_by" = 'invite') = ("sharednet"."room_member"."invite_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_invite_fk" FOREIGN KEY ("room_id","invite_id") REFERENCES "sharednet"."room_invite"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Convert every guest. Ids are minted here with random(); this backfill runs
-- once over a handful of rows and the ids only need to be unique, which the
-- primary keys enforce.
DO $$
DECLARE
  g RECORD;
  chars text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  pid text;
  iid text;
  body text;
  i int;
  seen timestamptz;
BEGIN
  FOR g IN SELECT * FROM sharednet.room_guest ORDER BY joined_at, id LOOP
    body := '';
    FOR i IN 1..10 LOOP body := body || substr(chars, 1 + floor(random() * 62)::int, 1); END LOOP;
    pid := 'p_' || body;
    body := '';
    FOR i IN 1..10 LOOP body := body || substr(chars, 1 + floor(random() * 62)::int, 1); END LOOP;
    iid := 'i_' || body;
    seen := GREATEST(g.last_seen_at, g.joined_at);
    INSERT INTO sharednet.principal (id, auth_user_id, display_name, created_at, invited_by_principal_id)
      VALUES (pid, NULL, g.name, g.joined_at, g.principal_id);
    INSERT INTO sharednet.instance (
      id, principal_id, agent_id, issued_by_key_id, token_digest, local_instance_key,
      runtime_kind, cli_version, runtime_metadata, state, started_at, last_seen_at,
      lease_expires_at, token_expires_at, ended_at, revoked_at, display_name, admitted_by_invite_id)
      VALUES (
      iid, pid, NULL, NULL, g.token_digest, NULL,
      'custom', 'invite', '{}'::jsonb,
      CASE WHEN g.state = 'active' THEN 'active' ELSE 'ended' END,
      g.joined_at, seen, seen + interval '90 seconds', NULL,
      CASE WHEN g.state = 'active' THEN NULL ELSE COALESCE(g.left_at, seen) END,
      NULL, g.name, g.invite_id);
    INSERT INTO sharednet.room_member (principal_id, room_id, instance_id, state, joined_at, left_at, admitted_by, invite_id)
      VALUES (pid, g.room_id, iid, g.state, g.joined_at, g.left_at, 'invite', g.invite_id);
    UPDATE sharednet.message
      SET sender_principal_id = pid, sender_instance_id = iid, sender_guest_id = NULL
      WHERE sender_guest_id = g.id;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "sharednet"."message" DROP CONSTRAINT "message_sender_exactly_one";--> statement-breakpoint
ALTER TABLE "sharednet"."message" DROP CONSTRAINT "message_sender_guest_fk";--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_sender_is_instance" CHECK ("sharednet"."message"."sender_instance_id" IS NOT NULL AND "sharednet"."message"."sender_guest_id" IS NULL);
