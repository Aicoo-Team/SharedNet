-- 0010: every Instance is permanent.
-- docs/decisions/2026-09-06-reach-public-or-private.md §2a
-- An Instance token no longer expires. New rows are written with a NULL
-- token_expires_at; the seats that exist today become permanent as well, so
-- an id that was ever handed out stays a usable address. Presence is still
-- the lease; offline is a state of the seat, not its end.
UPDATE "sharednet"."instance" SET "token_expires_at" = NULL WHERE "state" = 'active';
