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
  const started = await repository.startInstance(principalAuth, { runtime_kind: "codex", cli_version: "0.1.3", runtime_metadata: { workspace: "/w" } });
  const auth = await repository.authenticateInstance(started.token);
  return { userId, principalId: principalAuth.principalId, auth, instance: started.instance, key };
}

const owner = await account("owner");
const visitor = await account("visitor");
const ownerKey = owner.key;
const visitorKey = visitor.key;

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

// ---- Reads are filter, order, window, on real SQL. ----
const readLog = (input) => repository.listMessages(owner.auth, room.id, { after: 0, before: null, limit: 50, order: "asc", sender_instance_id: null, sender_agent_id: null, q: null, ...input });
assert.deepEqual((await readLog({ q: "SECOND" })).items.map((m) => m.sequence), [2], "grep is a case-insensitive substring");
assert.deepEqual((await readLog({ q: "%" })).items, [], "LIKE metacharacters are literal");
assert.deepEqual((await readLog({ order: "desc", limit: 2 })).items.map((m) => m.sequence), [3, 2], "newest first, top k");
assert.deepEqual((await readLog({ before: 3, limit: 5, order: "desc" })).items.map((m) => m.sequence), [2, 1], "paged backward");
assert.deepEqual((await readLog({ sender_instance_id: guest.membership.instance_id })).items.map((m) => m.sequence), [3], "by sender");
assert.deepEqual((await readLog({ sender_agent_id: "default", q: "first" })).items.map((m) => m.sequence), [1], "by tag, untagged, with grep");

// ---- Network: what each Principal can see. ----
const seatOfOwner2 = await repository.startInstance(await repository.authenticateApiKey(ownerKey), {
  runtime_kind: "claude-code",
  cli_version: "0.1.3",
});
const ownerNet = await repository.networkForPrincipal(owner.principalId);
assert.equal(ownerNet.principal.id, owner.principalId);
// Own Instances plus every co-member of a visible Room (the visitor left, the guest stayed).
assert.deepEqual(
  ownerNet.instances.map((i) => i.id).sort(),
  [owner.instance.id, seatOfOwner2.instance.id, guest.membership.instance_id].sort(),
);
assert.deepEqual(ownerNet.connected_principals.map((p) => [p.id, p.invited_by_principal_id]), [[guest.membership.principal_id, owner.principalId]]);
assert.deepEqual(ownerNet.edges, [
  { source_instance_id: [owner.instance.id, guest.membership.instance_id].sort()[0], target_instance_id: [owner.instance.id, guest.membership.instance_id].sort()[1], shared_rooms: 1, strength: 1 },
]);
// The visitor, with no seat left, sees only itself.
const visitorNet = await repository.networkForPrincipal(visitor.principalId);
assert.deepEqual(visitorNet.instances.map((i) => i.id), [visitor.instance.id]);
assert.deepEqual(visitorNet.connected_principals, []);
assert.deepEqual(visitorNet.edges, []);
await assert.rejects(repository.networkForPrincipal("p_nowhere0001"), { code: "principal_not_found" });

// ---- Decisions: a private Instance asked for, answered by its human. ----
const privateSeat = await repository.startInstance(await repository.authenticateApiKey(visitorKey), {
  runtime_kind: "codex",
  cli_version: "0.1.3",
  reach: "private",
});
const { room: second } = await repository.createRoom(owner.auth, { name: "Second", with: [privateSeat.instance.id] });
const { admissions } = await repository.addRoomMembers(owner.auth, second.id, { with: [privateSeat.instance.id] });
assert.equal(admissions[0].status, "pending");
const decisionId = admissions[0].decision_id;
const pending = await repository.listDecisionsForPrincipal(visitor.principalId);
assert.deepEqual(pending.decisions.map((d) => [d.decision.id, d.decision.status, d.requested_by_principal_id, d.decision.requested_for_instance_id]), [
  [decisionId, "pending", owner.principalId, privateSeat.instance.id],
]);
assert.deepEqual((await repository.listDecisionsForPrincipal(owner.principalId)).decisions, []);
await assert.rejects(repository.resolveDecisionForPrincipal(owner.principalId, decisionId, { outcome: "approved" }), { code: "decision_not_found", status: 404 });
await assert.rejects(repository.resolveDecisionForPrincipal(visitor.principalId, decisionId, { outcome: "answered", answer: "x" }), { code: "decision_resolution_invalid", status: 422 });
const approved = await repository.resolveDecisionForPrincipal(visitor.principalId, decisionId, { outcome: "approved" });
assert.equal(approved.decision.decision.status, "approved");
assert.ok(approved.decision.decision.resolved_at);
assert.deepEqual([approved.membership.instance_id, approved.membership.admitted_by, approved.membership.added_by_instance_id, approved.membership.state], [privateSeat.instance.id, "accepted", owner.instance.id, "active"]);
await assert.rejects(repository.resolveDecisionForPrincipal(visitor.principalId, decisionId, { outcome: "denied" }), { code: "decision_already_resolved", status: 409 });
// The seat is real: the visitor's account now sees the second Room.
assert.deepEqual((await repository.listRoomsForPrincipal(visitor.principalId)).items.map((i) => i.room.id), [second.id]);
// A request approved after its Room closed writes no seat, and stays pending.
const third = await repository.createRoom(owner.auth, { name: "Third", with: [privateSeat.instance.id] });
const thirdDecision = third.admissions[0].decision_id;
await repository.closeRoom(owner.principalId, third.room.id);
await assert.rejects(repository.resolveDecisionForPrincipal(visitor.principalId, thirdDecision, { outcome: "approved" }), { code: "room_closed", status: 409 });
assert.equal((await repository.listDecisionsForPrincipal(visitor.principalId)).decisions.find((d) => d.decision.id === thirdDecision).decision.status, "pending");

// ---- Seats of a CLI login: the approve page. ----
const { seats } = await repository.seatsOf([guest.membership.instance_id, privateSeat.instance.id, "i_nowhere0001"]);
assert.deepEqual(seats.map((s) => [s.instance.id, s.rooms.map((r) => r.id)]), [
  [guest.membership.instance_id, [room.id]],
  [privateSeat.instance.id, [second.id]],
]);

// Revoking an invite still goes through the same door.
const revoked = await repository.revokeRoomInvite({ inviteId: invite.id, principalId: owner.principalId });
assert.ok(revoked.invite.revoked_at);

await pool.end();
console.log(JSON.stringify({ status: "passed", room: room.id, scheduled: scheduled.room.id}));
