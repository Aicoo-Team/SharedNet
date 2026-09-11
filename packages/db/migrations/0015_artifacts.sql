-- 0015: artifacts, a file an Agent hands to a Room (decision 2026-09-11).
-- Metadata and bytes are separate tables so listing files does not drag
-- megabytes through the connection. The bytes live in the database for now:
-- it works in every environment the project already has, CI included, and
-- needs no vendor token; `ArtifactStore` is the seam to object storage.
-- Expand-only: two new tables, nothing existing changes.
CREATE TABLE "sharednet"."artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"uploaded_by_instance_id" text,
	"room_id" text,
	"reach" text DEFAULT 'room' NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"link_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_link_key_unique" UNIQUE("link_key"),
	CONSTRAINT "artifact_id_format" CHECK ("sharednet"."artifact"."id" ~ '^art_[0-9A-Za-z]{10}$'),
	CONSTRAINT "artifact_size_positive" CHECK ("sharednet"."artifact"."size_bytes" > 0),
	CONSTRAINT "artifact_sha256_format" CHECK ("sharednet"."artifact"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifact_filename_length" CHECK (length("sharednet"."artifact"."filename") BETWEEN 1 AND 120),
	CONSTRAINT "artifact_filename_is_a_name" CHECK ("sharednet"."artifact"."filename" !~ '[/\\]'),
	CONSTRAINT "artifact_reach_known" CHECK ("sharednet"."artifact"."reach" IN ('room', 'link', 'private')),
	CONSTRAINT "artifact_room_reach_has_a_room" CHECK ("sharednet"."artifact"."reach" <> 'room' OR "sharednet"."artifact"."room_id" IS NOT NULL),
	CONSTRAINT "artifact_link_reach_has_a_key" CHECK (("sharednet"."artifact"."reach" = 'link' AND "sharednet"."artifact"."link_key" IS NOT NULL) OR ("sharednet"."artifact"."reach" <> 'link' AND "sharednet"."artifact"."link_key" IS NULL)),
	CONSTRAINT "artifact_link_key_format" CHECK ("sharednet"."artifact"."link_key" IS NULL OR "sharednet"."artifact"."link_key" ~ '^afk_[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact" ADD CONSTRAINT "artifact_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "sharednet"."principal"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact" ADD CONSTRAINT "artifact_instance_fk" FOREIGN KEY ("uploaded_by_instance_id") REFERENCES "sharednet"."instance"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact" ADD CONSTRAINT "artifact_room_fk" FOREIGN KEY ("room_id") REFERENCES "sharednet"."room"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "artifact_principal_created_at_idx" ON "sharednet"."artifact" USING btree ("principal_id","created_at");
--> statement-breakpoint
CREATE INDEX "artifact_room_created_at_idx" ON "sharednet"."artifact" USING btree ("room_id","created_at");
--> statement-breakpoint
CREATE TABLE "sharednet"."artifact_bytes" (
	"artifact_id" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sharednet"."artifact_bytes" ADD CONSTRAINT "artifact_bytes_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "sharednet"."artifact"("id") ON DELETE cascade ON UPDATE no action;
