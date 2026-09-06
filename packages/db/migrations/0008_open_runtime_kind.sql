-- 0008: runtime_kind is any driver handle, not an enum of three.
-- The known list (claude-code, codex, opencode, openhands, gemini-cli, cursor,
-- custom) lives in clients, which pick an icon for it; the database only keeps
-- the value well-formed so a new driver needs no migration.
ALTER TABLE "sharednet"."instance" DROP CONSTRAINT "instance_runtime_kind_valid";--> statement-breakpoint
ALTER TABLE "sharednet"."instance" ADD CONSTRAINT "instance_runtime_kind_valid" CHECK ("sharednet"."instance"."runtime_kind" ~ '^[a-z][a-z0-9-]{0,31}$');
