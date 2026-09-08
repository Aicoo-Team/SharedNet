/**
 * The Dashboard's Room door against real PostgreSQL.
 *
 * The Web client reads and writes Rooms through the same repository the V1
 * API uses, scoped to an account's Principal. Its unit tests run on the
 * memory repository; this script proves the Postgres side of those methods
 * (visibility by ownership or active seat, counts, ordering, removal, close)
 * on a disposable database, seeded through the API's own doors.
 *
 *   TEST_DATABASE_URL=postgresql://…/sharednet_e2e node --experimental-strip-types scripts/dashboard-door-postgres-e2e.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { defaultKeyHasher } from "@better-auth/api-key";

const url = process.env.TEST_DATABASE_URL;
assert.ok(url && /e2e|test/.test(url), "TEST_DATABASE_URL must name a disposable database");
process.env.DATABASE_URL = url;
process.env.DATABASE_URL_UNPOOLED = url;

// The harness owns its database, the way v1-postgres-e2e does.
{
  const reset = new pg.Client({ connectionString: url });
  await reset.connect();
  try {
    await reset.query("DROP SCHEMA IF EXISTS sharednet, sharednet_auth, sharednet_migrations CASCADE");
  } finally {
    await reset.end();
  }
}
const { migrateDatabase } = await import("../packages/db/src/migrate.ts");
await migrateDatabase({ connectionString: url });
const { createDatabase } = await import("../packages/db/src/client.ts");
const { PostgresSharedNetRepository } = await import("../packages/server/src/postgres-repository.ts");

const pool = new pg.Pool({ connectionString: url });
const db = createDatabase(pool);
const repository = new PostgresSharedNetRepository(db);

async function account(label) {
  const userId = `u_${randomUUID()}`;
  const key = `snk_${Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43)}`;
  await pool.query(
    `insert into sharednet_auth."user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, false, now(), now())`,
    [userId, label, `${label}-${userId}@example.test`],
  );
  await pool.query(
    `insert into sharednet_auth.apikey (id, name, reference_id, key, enabled, created_at, updated_at) values ($1, $2, $3, $4, true, now(), now())`,
    [`key_${randomUUID().replace(/-/g, "").slice(0, 10)}`, label, userId, await defaultKeyHasher(key)],
  );
  const principalAuth = await repository.authenticateApiKey(key);
  assert.ok(principalAuth, "key authenticates");
  const started = await repository.startInstance(principalAuth, { runtime_kind: "codex", cli_version: "0.1.0", runtime_metadata: { workspace: "/w" } });
  const auth = await repository.authenticateInstance(started.token);
  return { userId, principalId: principalAuth.principalId, auth, instance: started.instance };
}

const owner = await account("owner");
const visitor = await account("visitor");

// The owner's Instance opens a Room and speaks; the visitor's Instance joins by Room id.
const { room } = await repository.createRoom(owner.auth, { name: "Door rehearsal", description: "pg" });
await repository.postMessage(owner.auth, room.id, { content: "first" });
await repository.joinRoom(visitor.auth, room.id);
await repository.postMessage(visitor.auth, room.id, { content: "second" });
// A guest arrives through an invite the owner minted from the Web.
const { invite, token } = await repository.createRoomInvite({ roomId: room.id, principalId: owner.principalId });
const guest = await repository.joinRoomWithInvite(token, room.id, { name: "claude-code", runtime: { kind: "claude-code", version: "1.0.0", source: "detected" } });
const guestAuth = await repository.authenticateInstance(guest.member_token);
await repository.postMessage(guestAuth, room.id, { content: "third" });
// And the Web schedules an empty Room of its own.
const scheduled = await repository.scheduleRoom(owner.principalId, { name: "Scheduled", description: null });
assert.equal(scheduled.room.creator_instance_id, null);

// principalForAccount resolves the same Principal the key did.
assert.equal((await repository.principalForAccount(owner.userId)).id, owner.principalId);
assert.equal(await repository.principalForAccount("nobody"), null);

// The owner lists both Rooms, newest first, with live counts.
const ownerList = await repository.listRoomsForPrincipal(owner.principalId);
assert.deepEqual(ownerList.items.map((i) => [i.room.id, i.active_member_count, i.latest_sequence]), [[scheduled.room.id, 0, 0], [room.id, 3, 3]]);
// The visitor sees only the Room it sits in.
const visitorList = await repository.listRoomsForPrincipal(visitor.principalId);
assert.deepEqual(visitorList.items.map((i) => i.room.id), [room.id]);

// Detail: three seats, three messages, the guest by name.
const detail = await repository.getRoomForPrincipal(visitor.principalId, room.id);
assert.deepEqual(detail.memberships.map((m) => [m.instance_id, m.kind, m.admitted_by, m.presence]), [
  [owner.instance.id, "instance", "room_id", "online"],
  [visitor.instance.id, "instance", "room_id", "online"],
  [guest.membership.instance_id, "guest", "invite", "online"],
]);
assert.deepEqual(detail.messages.map((m) => [m.sequence, m.sender.kind, m.sender.name, m.content]), [
  [1, "instance", null, "first"], [2, "instance", null, "second"], [3, "guest", "claude-code", "third"],
]);
assert.equal(detail.latest_sequence, 3);
assert.equal(detail.memberships[2].runtime_metadata.driver_version, "1.0.0");

// The visitor may neither close the Room nor remove a seat; the owner may.
await assert.rejects(repository.closeRoom(visitor.principalId, room.id), { code: "room_not_found", status: 404 });
await assert.rejects(repository.removeRoomMember(visitor.principalId, room.id, owner.instance.id), { code: "room_not_found" });
await assert.rejects(repository.removeRoomMember(owner.principalId, room.id, "i_nobody00001"), { code: "member_not_found", status: 404 });
const removed = await repository.removeRoomMember(owner.principalId, room.id, visitor.instance.id);
assert.equal(removed.membership.state, "left");
assert.ok(removed.membership.left_at);
const again = await repository.removeRoomMember(owner.principalId, room.id, visitor.instance.id);
assert.equal(again.membership.left_at, removed.membership.left_at);
// A left seat sees the Room no more, on either read.
await assert.rejects(repository.getRoomForPrincipal(visitor.principalId, room.id), { code: "room_not_found", status: 404 });
assert.deepEqual((await repository.listRoomsForPrincipal(visitor.principalId)).items, []);
await assert.rejects(repository.postMessage(visitor.auth, room.id, { content: "?" }), { status: 403 });

const closed = await repository.closeRoom(owner.principalId, room.id);
assert.equal(closed.room.state, "closed");
assert.ok(closed.room.closed_at);
assert.equal((await repository.closeRoom(owner.principalId, room.id)).room.closed_at, closed.room.closed_at);
await assert.rejects(repository.postMessage(owner.auth, room.id, { content: "late" }), { code: "room_closed" });
// Unknown Room and another account's scheduled Room both read as absent.
await assert.rejects(repository.getRoomForPrincipal(visitor.principalId, "rom_nowhere001"), { code: "room_not_found" });
await assert.rejects(repository.getRoomForPrincipal(visitor.principalId, scheduled.room.id), { code: "room_not_found" });
await assert.rejects(repository.scheduleRoom("p_nowhere0001", { name: "x", description: null }), { code: "principal_not_found" });

// Revoking an invite still goes through the same door.
const revoked = await repository.revokeRoomInvite({ inviteId: invite.id, principalId: owner.principalId });
assert.ok(revoked.invite.revoked_at);

await pool.end();
console.log(JSON.stringify({ status: "passed", room: room.id, scheduled: scheduled.room.id}));
