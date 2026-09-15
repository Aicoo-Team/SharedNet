-- 0014: credits, play money for a hackathon's trading round (decision
-- 2026-09-11). The purse belongs to the Principal. Every movement of value,
-- minted by a code or paid by a Principal, is one row in credit_transfer; the
-- account row is the running total the debit is checked against in the same
-- transaction (UPDATE … WHERE balance >= amount). A code is redeemable once
-- per Principal. Expand-only: four new tables, nothing existing changes.
CREATE TABLE "sharednet"."credit_account" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_account_balance_nonnegative" CHECK ("sharednet"."credit_account"."balance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sharednet"."credit_account" ADD CONSTRAINT "credit_account_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "sharednet"."credit_code" (
	"code" text PRIMARY KEY NOT NULL,
	"amount" bigint NOT NULL,
	"max_redemptions" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_code_format" CHECK ("sharednet"."credit_code"."code" ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
	CONSTRAINT "credit_code_amount_positive" CHECK ("sharednet"."credit_code"."amount" > 0),
	CONSTRAINT "credit_code_redemptions_nonnegative" CHECK ("sharednet"."credit_code"."redeemed_count" >= 0),
	CONSTRAINT "credit_code_redemptions_within_max" CHECK ("sharednet"."credit_code"."max_redemptions" IS NULL OR "sharednet"."credit_code"."redeemed_count" <= "sharednet"."credit_code"."max_redemptions")
);
--> statement-breakpoint
CREATE TABLE "sharednet"."credit_transfer" (
	"id" text PRIMARY KEY NOT NULL,
	"from_principal_id" text,
	"to_principal_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"memo" text,
	"room_id" text,
	"by_instance_id" text,
	"addressed_to" text NOT NULL,
	"code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transfer_id_format" CHECK ("sharednet"."credit_transfer"."id" ~ '^txn_[0-9A-Za-z]{10}$'),
	CONSTRAINT "credit_transfer_amount_positive" CHECK ("sharednet"."credit_transfer"."amount" > 0),
	CONSTRAINT "credit_transfer_minted_or_paid" CHECK (("sharednet"."credit_transfer"."from_principal_id" IS NULL AND "sharednet"."credit_transfer"."code" IS NOT NULL)
          OR ("sharednet"."credit_transfer"."from_principal_id" IS NOT NULL AND "sharednet"."credit_transfer"."code" IS NULL)),
	CONSTRAINT "credit_transfer_memo_length" CHECK ("sharednet"."credit_transfer"."memo" IS NULL OR length("sharednet"."credit_transfer"."memo") <= 200)
);
--> statement-breakpoint
ALTER TABLE "sharednet"."credit_transfer" ADD CONSTRAINT "credit_transfer_from_principal_fk" FOREIGN KEY ("from_principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sharednet"."credit_transfer" ADD CONSTRAINT "credit_transfer_to_principal_fk" FOREIGN KEY ("to_principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sharednet"."credit_transfer" ADD CONSTRAINT "credit_transfer_room_fk" FOREIGN KEY ("room_id") REFERENCES "sharednet"."room"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sharednet"."credit_transfer" ADD CONSTRAINT "credit_transfer_by_instance_fk" FOREIGN KEY ("by_instance_id") REFERENCES "sharednet"."instance"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "sharednet"."credit_transfer" ADD CONSTRAINT "credit_transfer_code_fk" FOREIGN KEY ("code") REFERENCES "sharednet"."credit_code"("code") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "credit_transfer_from_created_at_idx" ON "sharednet"."credit_transfer" USING btree ("from_principal_id","created_at");
--> statement-breakpoint
CREATE INDEX "credit_transfer_to_created_at_idx" ON "sharednet"."credit_transfer" USING btree ("to_principal_id","created_at");
--> statement-breakpoint
CREATE TABLE "sharednet"."credit_redemption" (
	"code" text NOT NULL,
	"principal_id" text NOT NULL,
	"transfer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_redemption_pk" PRIMARY KEY("code","principal_id")
);
--> statement-breakpoint
ALTER TABLE "sharednet"."credit_redemption" ADD CONSTRAINT "credit_redemption_code_fk" FOREIGN KEY ("code") REFERENCES "sharednet"."credit_code"("code") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sharednet"."credit_redemption" ADD CONSTRAINT "credit_redemption_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sharednet"."credit_redemption" ADD CONSTRAINT "credit_redemption_transfer_fk" FOREIGN KEY ("transfer_id") REFERENCES "sharednet"."credit_transfer"("id") ON DELETE no action ON UPDATE no action;
