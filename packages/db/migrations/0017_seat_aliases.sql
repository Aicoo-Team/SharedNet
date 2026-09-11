-- 0017: the name one account gives a seat it can see. A Room shows an
-- untagged Instance by its id, which is exact and unreadable; this is where a
-- human writes "Codex" over it. Per-viewer on purpose: letting anyone rename
-- anyone else's seat for everyone would be a way to misrepresent them.
CREATE TABLE "sharednet"."instance_alias" (
	"principal_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"alias" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_alias_pk" PRIMARY KEY("principal_id","instance_id"),
	CONSTRAINT "instance_alias_length" CHECK (length("sharednet"."instance_alias"."alias") BETWEEN 1 AND 48)
);
--> statement-breakpoint
ALTER TABLE "sharednet"."instance_alias" ADD CONSTRAINT "instance_alias_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sharednet"."instance_alias" ADD CONSTRAINT "instance_alias_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "sharednet"."instance"("id") ON DELETE cascade ON UPDATE cascade;
