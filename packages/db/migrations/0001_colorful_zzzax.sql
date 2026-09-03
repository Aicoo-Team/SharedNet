ALTER TABLE "sharednet"."instance" DROP CONSTRAINT "instance_issued_by_key_fk";
--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_issued_by_key_id_format" CHECK ("sharednet"."instance"."issued_by_key_id" ~ '^key_[0-9a-hjkmnp-tv-z]{26}$');