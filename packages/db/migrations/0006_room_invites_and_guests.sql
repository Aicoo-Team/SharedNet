CREATE TABLE "sharednet"."room_guest" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"invite_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"name" text NOT NULL,
	"token_digest" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_guest_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "room_guest_room_id_id_unique" UNIQUE("room_id","id"),
	CONSTRAINT "room_guest_id_format" CHECK ("sharednet"."room_guest"."id" ~ '^mem_[0-9A-Za-z]{10}$'),
	CONSTRAINT "room_guest_token_digest_format" CHECK ("sharednet"."room_guest"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "room_guest_name_length" CHECK (length("sharednet"."room_guest"."name") BETWEEN 1 AND 64),
	CONSTRAINT "room_guest_state_consistent" CHECK (("sharednet"."room_guest"."state" = 'active' AND "sharednet"."room_guest"."left_at" IS NULL)
          OR ("sharednet"."room_guest"."state" = 'left' AND "sharednet"."room_guest"."left_at" IS NOT NULL AND "sharednet"."room_guest"."left_at" >= "sharednet"."room_guest"."joined_at"))
);
--> statement-breakpoint
CREATE TABLE "sharednet"."room_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_invite_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "room_invite_room_id_id_unique" UNIQUE("room_id","id"),
	CONSTRAINT "room_invite_id_format" CHECK ("sharednet"."room_invite"."id" ~ '^inv_[0-9A-Za-z]{10}$'),
	CONSTRAINT "room_invite_token_digest_format" CHECK ("sharednet"."room_invite"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "room_invite_uses_nonnegative" CHECK ("sharednet"."room_invite"."uses" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sharednet"."idempotency_record" DROP CONSTRAINT "idempotency_credential_class_valid";--> statement-breakpoint
ALTER TABLE "sharednet"."idempotency_record" DROP CONSTRAINT "idempotency_actor_id_valid";--> statement-breakpoint
ALTER TABLE "sharednet"."message" ALTER COLUMN "sender_instance_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD COLUMN "sender_guest_id" text;--> statement-breakpoint
ALTER TABLE "sharednet"."room_guest" ADD CONSTRAINT "room_guest_room_fk" FOREIGN KEY ("room_id") REFERENCES "sharednet"."room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room_guest" ADD CONSTRAINT "room_guest_invite_fk" FOREIGN KEY ("room_id","invite_id") REFERENCES "sharednet"."room_invite"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room_guest" ADD CONSTRAINT "room_guest_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room_invite" ADD CONSTRAINT "room_invite_room_fk" FOREIGN KEY ("room_id") REFERENCES "sharednet"."room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room_invite" ADD CONSTRAINT "room_invite_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_guest_room_idx" ON "sharednet"."room_guest" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_invite_room_idx" ON "sharednet"."room_invite" USING btree ("room_id");--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_sender_guest_fk" FOREIGN KEY ("room_id","sender_guest_id") REFERENCES "sharednet"."room_guest"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."idempotency_record" ADD CONSTRAINT "idempotency_credential_class_valid" CHECK ("sharednet"."idempotency_record"."credential_class" IN ('web_session', 'api_key', 'instance', 'guest'));--> statement-breakpoint
ALTER TABLE "sharednet"."idempotency_record" ADD CONSTRAINT "idempotency_actor_id_valid" CHECK (("sharednet"."idempotency_record"."credential_class" = 'web_session' AND length("sharednet"."idempotency_record"."actor_id") > 0)
          OR ("sharednet"."idempotency_record"."credential_class" = 'api_key' AND "sharednet"."idempotency_record"."actor_id" ~ '^key_[0-9A-Za-z]{10}$')
          OR ("sharednet"."idempotency_record"."credential_class" = 'instance' AND "sharednet"."idempotency_record"."actor_id" ~ '^i_[0-9A-Za-z]{10}$')
          OR ("sharednet"."idempotency_record"."credential_class" = 'guest' AND "sharednet"."idempotency_record"."actor_id" ~ '^mem_[0-9A-Za-z]{10}$'));--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_sender_exactly_one" CHECK (("sharednet"."message"."sender_instance_id" IS NULL) <> ("sharednet"."message"."sender_guest_id" IS NULL));