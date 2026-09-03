CREATE SCHEMA "sharednet_auth";
--> statement-breakpoint
CREATE SCHEMA "sharednet";
--> statement-breakpoint
CREATE TABLE "sharednet_auth"."apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_time_window" integer DEFAULT 86400000 NOT NULL,
	"rate_limit_max" integer DEFAULT 10 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"permissions" text,
	"metadata" text,
	CONSTRAINT "auth_apikey_key_unique" UNIQUE("key"),
	CONSTRAINT "auth_apikey_id_format" CHECK ("sharednet_auth"."apikey"."id" ~ '^key_[0-9a-hjkmnp-tv-z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "sharednet_auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_account_issuer_account_id_unique" UNIQUE("issuer","account_id")
);
--> statement-breakpoint
CREATE TABLE "sharednet_auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "sharednet_auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "sharednet_auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sharednet"."agent" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_principal_id_id_unique" UNIQUE("principal_id","id"),
	CONSTRAINT "agent_principal_handle_unique" UNIQUE("principal_id","handle"),
	CONSTRAINT "agent_id_format" CHECK ("sharednet"."agent"."id" ~ '^agt_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "agent_handle_format" CHECK ("sharednet"."agent"."handle" ~ '^[a-z][a-z0-9-]{0,31}$'),
	CONSTRAINT "agent_default_handle_consistent" CHECK (("sharednet"."agent"."is_default" AND "sharednet"."agent"."handle" = 'default') OR (NOT "sharednet"."agent"."is_default" AND "sharednet"."agent"."handle" <> 'default'))
);
--> statement-breakpoint
CREATE TABLE "sharednet"."decision" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"mode" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_agent_id" text NOT NULL,
	"requested_by_instance_id" text NOT NULL,
	"room_id" text,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "decision_id_format" CHECK ("sharednet"."decision"."id" ~ '^dec_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "decision_mode_valid" CHECK ("sharednet"."decision"."mode" IN ('approval', 'text')),
	CONSTRAINT "decision_state_consistent" CHECK ((
            "sharednet"."decision"."mode" = 'approval'
            AND (
              ("sharednet"."decision"."status" = 'pending' AND "sharednet"."decision"."answer" IS NULL AND "sharednet"."decision"."resolved_at" IS NULL)
              OR ("sharednet"."decision"."status" IN ('approved', 'denied') AND "sharednet"."decision"."answer" IS NULL AND "sharednet"."decision"."resolved_at" IS NOT NULL)
            )
          ) OR (
            "sharednet"."decision"."mode" = 'text'
            AND (
              ("sharednet"."decision"."status" = 'pending' AND "sharednet"."decision"."answer" IS NULL AND "sharednet"."decision"."resolved_at" IS NULL)
              OR ("sharednet"."decision"."status" = 'answered' AND "sharednet"."decision"."answer" IS NOT NULL AND length(btrim("sharednet"."decision"."answer")) > 0 AND "sharednet"."decision"."resolved_at" IS NOT NULL)
            )
          ))
);
--> statement-breakpoint
CREATE TABLE "sharednet"."idempotency_record" (
	"principal_id" text NOT NULL,
	"credential_class" text NOT NULL,
	"actor_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_record_pk" PRIMARY KEY("principal_id","credential_class","actor_id","operation_id","idempotency_key"),
	CONSTRAINT "idempotency_credential_class_valid" CHECK ("sharednet"."idempotency_record"."credential_class" IN ('web_session', 'api_key', 'instance')),
	CONSTRAINT "idempotency_actor_id_valid" CHECK (("sharednet"."idempotency_record"."credential_class" = 'web_session' AND length("sharednet"."idempotency_record"."actor_id") > 0)
          OR ("sharednet"."idempotency_record"."credential_class" = 'api_key' AND "sharednet"."idempotency_record"."actor_id" ~ '^key_[0-9a-hjkmnp-tv-z]{26}$')
          OR ("sharednet"."idempotency_record"."credential_class" = 'instance' AND "sharednet"."idempotency_record"."actor_id" ~ '^ins_[0-9a-hjkmnp-tv-z]{26}$')),
	CONSTRAINT "idempotency_uuid_v4" CHECK ("sharednet"."idempotency_record"."idempotency_key"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "idempotency_request_fingerprint_format" CHECK ("sharednet"."idempotency_record"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_response_status_success" CHECK ("sharednet"."idempotency_record"."response_status" BETWEEN 200 AND 299),
	CONSTRAINT "idempotency_response_body_bounded" CHECK (octet_length("sharednet"."idempotency_record"."response_body") <= 65536),
	CONSTRAINT "idempotency_retention_minimum" CHECK ("sharednet"."idempotency_record"."expires_at" >= "sharednet"."idempotency_record"."created_at" + interval '24 hours')
);
--> statement-breakpoint
CREATE TABLE "sharednet"."instance" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"issued_by_key_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"runtime_kind" text NOT NULL,
	"cli_version" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "instance_principal_agent_id_unique" UNIQUE("principal_id","agent_id","id"),
	CONSTRAINT "instance_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "instance_id_format" CHECK ("sharednet"."instance"."id" ~ '^ins_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "instance_token_digest_format" CHECK ("sharednet"."instance"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "instance_runtime_kind_valid" CHECK ("sharednet"."instance"."runtime_kind" IN ('codex', 'claude-code', 'custom')),
	CONSTRAINT "instance_cli_version_length" CHECK (length("sharednet"."instance"."cli_version") BETWEEN 1 AND 64),
	CONSTRAINT "instance_state_valid" CHECK ("sharednet"."instance"."state" IN ('active', 'ended', 'revoked')),
	CONSTRAINT "instance_terminal_state_consistent" CHECK (("sharednet"."instance"."state" = 'active' AND "sharednet"."instance"."ended_at" IS NULL AND "sharednet"."instance"."revoked_at" IS NULL)
          OR ("sharednet"."instance"."state" = 'ended' AND "sharednet"."instance"."ended_at" IS NOT NULL AND "sharednet"."instance"."revoked_at" IS NULL)
          OR ("sharednet"."instance"."state" = 'revoked' AND "sharednet"."instance"."revoked_at" IS NOT NULL AND "sharednet"."instance"."ended_at" IS NULL)),
	CONSTRAINT "instance_time_order_valid" CHECK ("sharednet"."instance"."last_seen_at" >= "sharednet"."instance"."started_at"
          AND "sharednet"."instance"."lease_expires_at" > "sharednet"."instance"."last_seen_at"
          AND "sharednet"."instance"."token_expires_at" > "sharednet"."instance"."started_at")
);
--> statement-breakpoint
CREATE TABLE "sharednet"."message" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"sender_principal_id" text NOT NULL,
	"sender_agent_id" text NOT NULL,
	"sender_instance_id" text NOT NULL,
	"content" text NOT NULL,
	"reply_to_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_room_sequence_unique" UNIQUE("room_id","sequence"),
	CONSTRAINT "message_room_id_unique" UNIQUE("room_id","id"),
	CONSTRAINT "message_id_format" CHECK ("sharednet"."message"."id" ~ '^msg_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "message_sequence_positive" CHECK ("sharednet"."message"."sequence" >= 1),
	CONSTRAINT "message_content_valid" CHECK (length(btrim("sharednet"."message"."content")) > 0 AND octet_length("sharednet"."message"."content") <= 32768)
);
--> statement-breakpoint
CREATE TABLE "sharednet"."principal" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_user_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_auth_user_id_unique" UNIQUE("auth_user_id"),
	CONSTRAINT "principal_id_format" CHECK ("sharednet"."principal"."id" ~ '^pri_[0-9a-hjkmnp-tv-z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "sharednet"."room_member" (
	"principal_id" text NOT NULL,
	"room_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "room_member_pk" PRIMARY KEY("room_id","agent_id"),
	CONSTRAINT "room_member_room_id_format" CHECK ("sharednet"."room_member"."room_id" ~ '^rom_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "room_member_agent_id_format" CHECK ("sharednet"."room_member"."agent_id" ~ '^agt_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "room_member_state_consistent" CHECK (("sharednet"."room_member"."state" = 'active' AND "sharednet"."room_member"."left_at" IS NULL)
          OR ("sharednet"."room_member"."state" = 'left' AND "sharednet"."room_member"."left_at" IS NOT NULL AND "sharednet"."room_member"."left_at" >= "sharednet"."room_member"."joined_at"))
);
--> statement-breakpoint
CREATE TABLE "sharednet"."room" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'open' NOT NULL,
	"creator_agent_id" text NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "room_principal_id_id_unique" UNIQUE("principal_id","id"),
	CONSTRAINT "room_id_format" CHECK ("sharednet"."room"."id" ~ '^rom_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "room_name_length" CHECK (length("sharednet"."room"."name") BETWEEN 1 AND 120),
	CONSTRAINT "room_description_length" CHECK ("sharednet"."room"."description" IS NULL OR length("sharednet"."room"."description") <= 2000),
	CONSTRAINT "room_next_sequence_positive" CHECK ("sharednet"."room"."next_sequence" >= 1),
	CONSTRAINT "room_state_consistent" CHECK (("sharednet"."room"."state" = 'open' AND "sharednet"."room"."closed_at" IS NULL)
          OR ("sharednet"."room"."state" = 'closed' AND "sharednet"."room"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "sharednet_auth"."apikey" ADD CONSTRAINT "apikey_reference_id_user_id_fk" FOREIGN KEY ("reference_id") REFERENCES "sharednet_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet_auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "sharednet_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet_auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "sharednet_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."agent" ADD CONSTRAINT "agent_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_requester_agent_fk" FOREIGN KEY ("principal_id","requested_by_agent_id") REFERENCES "sharednet"."agent"("principal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_requester_instance_fk" FOREIGN KEY ("principal_id","requested_by_agent_id","requested_by_instance_id") REFERENCES "sharednet"."instance"("principal_id","agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."decision" ADD CONSTRAINT "decision_room_fk" FOREIGN KEY ("principal_id","room_id") REFERENCES "sharednet"."room"("principal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."idempotency_record" ADD CONSTRAINT "idempotency_record_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_principal_agent_fk" FOREIGN KEY ("principal_id","agent_id") REFERENCES "sharednet"."agent"("principal_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_issued_by_key_fk" FOREIGN KEY ("issued_by_key_id") REFERENCES "sharednet_auth"."apikey"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_room_fk" FOREIGN KEY ("sender_principal_id","room_id") REFERENCES "sharednet"."room"("principal_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_sender_agent_fk" FOREIGN KEY ("sender_principal_id","sender_agent_id") REFERENCES "sharednet"."agent"("principal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_sender_instance_fk" FOREIGN KEY ("sender_principal_id","sender_agent_id","sender_instance_id") REFERENCES "sharednet"."instance"("principal_id","agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_sender_membership_fk" FOREIGN KEY ("room_id","sender_agent_id") REFERENCES "sharednet"."room_member"("room_id","agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_same_room_reply_fk" FOREIGN KEY ("room_id","reply_to_message_id") REFERENCES "sharednet"."message"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."principal" ADD CONSTRAINT "principal_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "sharednet_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_room_fk" FOREIGN KEY ("principal_id","room_id") REFERENCES "sharednet"."room"("principal_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_agent_fk" FOREIGN KEY ("principal_id","agent_id") REFERENCES "sharednet"."agent"("principal_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD CONSTRAINT "room_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room" ADD CONSTRAINT "room_creator_agent_fk" FOREIGN KEY ("principal_id","creator_agent_id") REFERENCES "sharednet"."agent"("principal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_apikey_config_id_idx" ON "sharednet_auth"."apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "auth_apikey_reference_id_idx" ON "sharednet_auth"."apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "sharednet_auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "sharednet_auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "sharednet_auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_one_default_per_principal" ON "sharednet"."agent" USING btree ("principal_id") WHERE "sharednet"."agent"."is_default";--> statement-breakpoint
CREATE INDEX "decision_principal_created_at_idx" ON "sharednet"."decision" USING btree ("principal_id","created_at");--> statement-breakpoint
CREATE INDEX "decision_principal_status_idx" ON "sharednet"."decision" USING btree ("principal_id","status");--> statement-breakpoint
CREATE INDEX "idempotency_record_expiry_idx" ON "sharednet"."idempotency_record" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "instance_principal_idx" ON "sharednet"."instance" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "instance_agent_idx" ON "sharednet"."instance" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "instance_issued_by_key_idx" ON "sharednet"."instance" USING btree ("issued_by_key_id");--> statement-breakpoint
CREATE INDEX "instance_lease_expires_at_idx" ON "sharednet"."instance" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "message_room_created_at_idx" ON "sharednet"."message" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "message_sender_instance_idx" ON "sharednet"."message" USING btree ("sender_instance_id");--> statement-breakpoint
CREATE INDEX "room_member_principal_agent_idx" ON "sharednet"."room_member" USING btree ("principal_id","agent_id");--> statement-breakpoint
CREATE INDEX "room_principal_created_at_idx" ON "sharednet"."room" USING btree ("principal_id","created_at");