-- 0019: a person's avatar, stored rather than linked (decision 2026-09-12).
-- Google hands back a googleusercontent.com URL. Pointing an <img> at it makes
-- every page view a request to Google, the URL rotates, and on a network that
-- cannot reach Google the person simply has no face. So the picture is fetched
-- once and served from this origin under an opaque id — never under the
-- account's own id, which would put a user identifier in a public URL.
-- Expand-only: one new table.
CREATE TABLE "sharednet"."user_avatar" (
	"auth_user_id" text PRIMARY KEY NOT NULL,
	"avatar_id" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_avatar_avatar_id_unique" UNIQUE("avatar_id"),
	CONSTRAINT "user_avatar_id_format" CHECK ("sharednet"."user_avatar"."avatar_id" ~ '^ava_[0-9A-Za-z]{10}$'),
	CONSTRAINT "user_avatar_size_positive" CHECK ("sharednet"."user_avatar"."size_bytes" > 0),
	CONSTRAINT "user_avatar_sha256_format" CHECK ("sharednet"."user_avatar"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "user_avatar_content_type_known" CHECK ("sharednet"."user_avatar"."content_type" IN ('image/png', 'image/jpeg', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "sharednet"."user_avatar" ADD CONSTRAINT "user_avatar_user_fk" FOREIGN KEY ("auth_user_id") REFERENCES "sharednet_auth"."user"("id") ON DELETE cascade ON UPDATE no action;
