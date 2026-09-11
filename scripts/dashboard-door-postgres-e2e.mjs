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
import { createHash, randomUUID } from "node:crypto";
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
const { handleRequest } = await import("../packages/server/src/handler.ts");

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

// ---- Sharing: the owner publishes a Room at a slug; anyone reads it by the slug alone. ----
await assert.rejects(repository.shareRoom(visitor.principalId, room.id), { code: "room_not_found", status: 404 });
const shared = await repository.shareRoom(owner.principalId, room.id);
assert.match(shared.share_token, /^shr_[A-Za-z0-9_-]{43}$/);
assert.ok(shared.room.shared_at, "the Room records since when it is public");
assert.equal(shared.room.state, "closed", "a closed Room can be published");
// The same link every time it is asked for, on both the share door and the owner's detail.
assert.equal((await repository.shareRoom(owner.principalId, room.id)).share_token, shared.share_token);
assert.equal((await repository.getRoomForPrincipal(owner.principalId, room.id)).share_token, shared.share_token);
// The public door: the whole log, and the handles behind the tags, for nobody in particular.
const publicView = await repository.getSharedRoom(shared.share_token);
assert.equal(publicView.room.id, room.id);
assert.deepEqual(publicView.messages.map((m) => [m.sequence, m.sender.kind, m.content]), [[1, "instance", "first"], [2, "instance", "second"], [3, "guest", "third"]]);
assert.equal(publicView.memberships.length, 3);
assert.deepEqual(publicView.agent_handles, {}, "untagged seats carry no handles");
// A slug that is not one, and one nobody minted, both read as absent; so does the Room id.
await assert.rejects(repository.getSharedRoom(room.id), { code: "room_not_found", status: 404 });
await assert.rejects(repository.getSharedRoom(`shr_${"z".repeat(43)}`), { code: "room_not_found", status: 404 });
// Stopping is immediate and only the owner's; sharing again mints a new slug.
await assert.rejects(repository.unshareRoom(visitor.principalId, room.id), { code: "room_not_found", status: 404 });
const unshared = await repository.unshareRoom(owner.principalId, room.id);
assert.equal(unshared.room.shared_at, null);
await assert.rejects(repository.getSharedRoom(shared.share_token), { code: "room_not_found", status: 404 });
assert.equal((await repository.unshareRoom(owner.principalId, room.id)).room.shared_at, null, "unsharing twice is a no-op");
const reshared = await repository.shareRoom(owner.principalId, room.id);
assert.notEqual(reshared.share_token, shared.share_token);
// A tagged seat's handle reaches the public view, so a reader sees a name rather than an id.
const taggedKey = await repository.authenticateApiKey(ownerKey);
const tag = await repository.createAgent(taggedKey, { handle: "narrator" });
const tagged = await repository.startInstance(taggedKey, { runtime_kind: "claude-code", cli_version: "0.1.3", agent_id: tag.agent.id });
const taggedAuth = await repository.authenticateInstance(tagged.token);
const { room: fourth } = await repository.createRoom(taggedAuth, { name: "Fourth" });
await repository.postMessage(taggedAuth, fourth.id, { content: "hello" });
const fourthShared = await repository.shareRoom(owner.principalId, fourth.id);
assert.deepEqual((await repository.getSharedRoom(fourthShared.share_token)).agent_handles, { [tag.agent.id]: "narrator" });

// ---- Credits: a purse per Principal on real SQL; the debit is a conditional UPDATE. ----
await repository.mintCreditCode({ code: "DOOR-100", amount: 100, max_redemptions: 2 });
await repository.mintCreditCode({ code: "STALE", amount: 5, expires_at: "2020-01-01T00:00:00.000Z" });
const ownerKeyAuth = await repository.authenticateApiKey(ownerKey);
const redeemed = await repository.redeemCredits(ownerKeyAuth, "DOOR-100");
assert.equal(redeemed.granted, 100);
assert.deepEqual([redeemed.credits.balance, redeemed.credits.granted, redeemed.transfer.from_principal_id, redeemed.transfer.code], [100, 100, null, "DOOR-100"]);
assert.deepEqual((await repository.redeemCredits(owner.auth, "DOOR-100")).granted, 0, "the same account redeems once; a retry grants nothing");
assert.equal((await repository.redeemCredits(visitor.auth, "DOOR-100")).granted, 100);
await assert.rejects(repository.redeemCredits(guestAuth, "DOOR-100"), { code: "credits_account_required", status: 403 });
await assert.rejects(repository.redeemCredits(owner.auth, "STALE"), { code: "credit_code_expired", status: 410 });
await assert.rejects(repository.redeemCredits(owner.auth, "NOPE"), { code: "credit_code_not_found", status: 404 });
// The human's door reads the same purse.
assert.equal((await repository.creditsForPrincipal(owner.principalId)).credits.balance, 100);
assert.equal((await repository.redeemCreditsForPrincipal(owner.principalId, "DOOR-100")).granted, 0);
// Pay by Instance id: the visitor's seat resolves to the visitor's purse; the seat that paid is recorded.
const paid = await repository.transferCredits(owner.auth, { to: visitor.instance.id, amount: 30, memo: "map tiles", room_id: room.id });
assert.deepEqual(
  [paid.transfer.from_principal_id, paid.transfer.to_principal_id, paid.transfer.amount, paid.transfer.by_instance_id, paid.transfer.room_id, paid.credits.balance],
  [owner.principalId, visitor.principalId, 30, owner.instance.id, room.id, 70],
);
assert.deepEqual((await repository.getCredits(visitor.auth)).credits, { principal_id: visitor.principalId, balance: 130, granted: 100, sent: 0, received: 30 });
await assert.rejects(repository.transferCredits(owner.auth, { to: visitor.principalId, amount: 71 }), { code: "insufficient_credits", status: 409 });
await assert.rejects(repository.transferCredits(owner.auth, { to: "i_nobody00001", amount: 1 }), { code: "payee_not_found", status: 404 });
await assert.rejects(repository.transferCredits(owner.auth, { to: owner.instance.id, amount: 1 }), { code: "transfer_to_self", status: 422 });
// Two payments racing for one purse: exactly one of a pair that together exceed it can pass.
const race = await Promise.allSettled([
  repository.transferCredits(owner.auth, { to: visitor.principalId, amount: 50 }),
  repository.transferCredits(owner.auth, { to: visitor.principalId, amount: 50 }),
]);
assert.deepEqual(race.map((r) => r.status).sort(), ["fulfilled", "rejected"], "one of two racing debits wins");
assert.equal((await repository.getCredits(owner.auth)).credits.balance, 20);
// The ledger, newest first, paged by id; the balance recomputed from it matches the purse.
const page = await repository.listCreditTransfers(owner.auth, { limit: 2, before: null });
assert.deepEqual(page.items.map((t) => t.amount), [50, 30]);
assert.equal(page.has_more, true);
const rest = await repository.listCreditTransfers(owner.auth, { limit: 10, before: page.next_cursor });
assert.deepEqual(rest.items.map((t) => [t.amount, t.code]), [[100, "DOOR-100"]]);
await assert.rejects(repository.listCreditTransfers(owner.auth, { limit: 10, before: "txn_nowhere001" }), { code: "invalid_cursor" });
const everything = [...page.items, ...rest.items];
const recomputed = everything.reduce((sum, t) => sum + (t.to_principal_id === owner.principalId ? t.amount : 0) - (t.from_principal_id === owner.principalId ? t.amount : 0), 0);
assert.equal(recomputed, (await repository.getCredits(owner.auth)).credits.balance, "the purse is the sum of the ledger");

// Two purses paying each other at the same moment must not deadlock: both
// transactions take the two row locks in the same (id) order.
const [payerOne, payerTwo] = [owner, visitor];
const swap = await Promise.allSettled([
  repository.transferCredits(payerOne.auth, { to: payerTwo.principalId, amount: 1, memo: "swap a" }),
  repository.transferCredits(payerTwo.auth, { to: payerOne.principalId, amount: 1, memo: "swap b" }),
]);
assert.deepEqual(swap.map((r) => r.status), ["fulfilled", "fulfilled"], `cross payments must not deadlock: ${swap.map((r) => r.reason?.message ?? "ok")}`);

// One key, two requests, the whole purse: the loser replays the winner's
// response rather than being told the money it already moved is missing.
const wholePurse = (await repository.getCredits(owner.auth)).credits.balance;
assert.ok(wholePurse > 0, "the owner has something to spend");
const sharedKey = randomUUID();
const scopeFor = () => ({ principalId: owner.principalId, credentialClass: "instance", actorId: owner.instance.id, operationId: "transferCredits", key: sharedKey });
const attempt = () =>
  repository.executeIdempotent(scopeFor(), createHash("sha256").update("the same request body").digest("hex"), async () => ({
    status: 201,
    body: JSON.stringify(await repository.transferCredits(owner.auth, { to: visitor.principalId, amount: wholePurse })),
  }));
const [keyRaceA, keyRaceB] = await Promise.all([attempt(), attempt()]);
assert.deepEqual([keyRaceA.status, keyRaceB.status], [201, 201], "both answers are the created response");
assert.equal(keyRaceA.body, keyRaceB.body, "the loser replays the winner's response");
assert.deepEqual([keyRaceA.replayed, keyRaceB.replayed].sort(), [false, true], "exactly one of the two actually ran");
assert.equal((await repository.getCredits(owner.auth)).credits.balance, 0, "the purse was spent once, not twice");

// A guest paid before its human logged in keeps the credits: binding moves the purse.
const guestPay = await repository.transferCredits(visitor.auth, { to: guest.membership.instance_id, amount: 7, memo: "for the guest" });
assert.equal(guestPay.transfer.to_principal_id, guest.membership.principal_id);
assert.equal((await repository.getCredits(guestAuth)).credits.balance, 7);
const guestLogin = await repository.startCliLogin({ label: "guest laptop", seats: [guest.member_token] });
const beforeBinding = (await repository.getCredits(owner.auth)).credits.balance;
const bindingApproval = await repository.approveCliLogin({ code: guestLogin.user_code, principalId: owner.principalId });
assert.deepEqual(bindingApproval.bound_principal_ids, [guest.membership.principal_id], "the guest's Principal was bound into the account");
const afterBinding = await repository.getCredits(owner.auth);
assert.equal(afterBinding.credits.balance, beforeBinding + 7, "the guest's credits moved into the account that claimed it");
// The seat's token is unchanged; re-authenticating it is what a CLI does on
// every call, and it now resolves to the account's Principal and its purse.
const boundAuth = await repository.authenticateInstance(guest.member_token);
assert.equal(boundAuth.principalId, owner.principalId, "the seat now acts as the account");
assert.equal((await repository.getCredits(boundAuth)).credits.balance, afterBinding.credits.balance, "the same seat now spends from the account's purse");
const movedRow = (await repository.listCreditTransfers(owner.auth, { limit: 1, before: null })).items[0];
assert.deepEqual([movedRow.amount, movedRow.from_principal_id, movedRow.memo], [7, guest.membership.principal_id, "Bound into this account by sharednet login"]);

// ---- A claim while credits are in flight. ----
// A second guest, paid before its human claims the seat: the claim and a
// payment out of that purse run at the same moment. Whichever order they land
// in, the credits are neither lost nor conjured, and the ledger still sums.
const raceInvite = await repository.createRoomInvite({ roomId: second.id, principalId: owner.principalId });
const racer = await repository.joinRoomWithInvite(raceInvite.token, second.id, { name: "racer", runtime: { kind: "curl" } });
const racerAuth = await repository.authenticateInstance(racer.member_token);
await repository.transferCredits(visitor.auth, { to: racer.membership.instance_id, amount: 30 });
assert.equal((await repository.getCredits(racerAuth)).credits.balance, 30);
const racerLogin = await repository.startCliLogin({ label: "racer laptop", seats: [racer.member_token] });
const claimerBefore = (await repository.getCredits(visitor.auth)).credits.balance;
const spendRace = await Promise.allSettled([
  repository.approveCliLogin({ code: racerLogin.user_code, principalId: visitor.principalId }),
  repository.transferCredits(racerAuth, { to: owner.principalId, amount: 10, memo: "spent mid-claim" }),
]);
assert.equal(spendRace[0].status, "fulfilled", `the claim must not deadlock: ${spendRace[0].reason?.message ?? ""}`);
const spendLanded = spendRace[1].status === "fulfilled";
if (!spendLanded) {
  assert.match(spendRace[1].reason?.code ?? "", /credits_identity_moved|insufficient_credits/, `a refused mid-claim payment is refused for a stated reason, not a crash: ${spendRace[1].reason?.message ?? ""}`);
}
// Whatever happened, the claimer holds the guest's purse minus anything that was spent.
const claimerAfter = (await repository.getCredits(visitor.auth)).credits.balance;
assert.equal(claimerAfter, claimerBefore + 30 - (spendLanded ? 10 : 0), "the claimed purse is exactly what the guest had, less what it spent");
// The bound Principal keeps nothing behind.
const strandedRacer = await repository.listCreditTransfers(visitor.auth, { limit: 100, before: null });
const racerSum = strandedRacer.items.reduce(
  (sum, t) => sum + (t.to_principal_id === visitor.principalId ? t.amount : 0) - (t.from_principal_id === visitor.principalId ? t.amount : 0),
  0,
);
assert.equal(racerSum, claimerAfter, "after a claim, the claimer's balance is still the sum of its ledger");

// Money arriving for a seat that is being claimed lands in the account that claimed it.
const incomingInvite = await repository.createRoomInvite({ roomId: second.id, principalId: owner.principalId });
const incoming = await repository.joinRoomWithInvite(incomingInvite.token, second.id, { name: "incoming", runtime: { kind: "curl" } });
const incomingLogin = await repository.startCliLogin({ label: "incoming laptop", seats: [incoming.member_token] });
const ownerBefore = (await repository.getCredits(owner.auth)).credits.balance;
const payerBefore = (await repository.getCredits(visitor.auth)).credits.balance;
const incomingRace = await Promise.allSettled([
  repository.approveCliLogin({ code: incomingLogin.user_code, principalId: owner.principalId }),
  repository.transferCredits(visitor.auth, { to: incoming.membership.instance_id, amount: 4, memo: "paid mid-claim" }),
]);
assert.equal(incomingRace[0].status, "fulfilled", `the claim must not deadlock: ${incomingRace[0].reason?.message ?? ""}`);
if (incomingRace[1].status === "fulfilled") {
  const landedOn = incomingRace[1].value.transfer.to_principal_id;
  assert.ok(
    landedOn === owner.principalId || landedOn === incoming.membership.principal_id,
    "an incoming payment lands on one of the two identities, never on nothing",
  );
  const claimedAuth = await repository.authenticateInstance(incoming.member_token);
  assert.equal(claimedAuth.principalId, owner.principalId, "the seat is the account's now");
  // The seat must be able to spend what it was paid, whichever side it landed on.
  assert.equal(
    (await repository.getCredits(claimedAuth)).credits.balance,
    ownerBefore + 4,
    "the payment is spendable by the seat that was paid, through the account that claimed it",
  );
  assert.equal((await repository.getCredits(visitor.auth)).credits.balance, payerBefore - 4);
} else {
  assert.match(incomingRace[1].reason?.code ?? "", /credits_identity_moved/, "a payment across a finishing claim is refused by name");
  assert.equal((await repository.getCredits(visitor.auth)).credits.balance, payerBefore, "a refused payment moved nothing");
}

// ---- Deterministic identity races: pause real SQL at the lock boundary. ----
// Every query still reaches PostgreSQL. Gates choose the interleaving, so a
// passing run cannot merely mean the scheduler avoided the contested window.
function gate() {
  const arrived = Promise.withResolvers();
  const released = Promise.withResolvers();
  const timeout = setTimeout(() => arrived.reject(new Error("the request did not reach its SQL gate")), 5_000);
  return {
    arrived: arrived.promise,
    release() { clearTimeout(timeout); released.resolve(); },
    async pause() { clearTimeout(timeout); arrived.resolve(); await released.promise; },
  };
}

async function controlledRepository(hook = {}) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const pid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
  const query = client.query.bind(client);
  client.query = async (...args) => {
    const statement = typeof args[0] === "string" ? args[0] : args[0].text;
    const values = args[1] ?? args[0].values ?? [];
    await hook.before?.(statement, values);
    const result = await query(...args);
    await hook.after?.(statement, values);
    return result;
  };
  return { repository: new PostgresSharedNetRepository(createDatabase(client)), client, pid };
}

async function waitForDatabaseLock(pid, completed = () => false) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (completed()) return false;
    const { rows } = await pool.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("the concurrent request must reach the controlled PostgreSQL lock");
}

async function raceGuest(name) {
  const invitation = await repository.createRoomInvite({ roomId: second.id, principalId: owner.principalId });
  const seat = await repository.joinRoomWithInvite(invitation.token, second.id, { name, runtime: { kind: "curl" } });
  return { ...seat, auth: await repository.authenticateInstance(seat.member_token) };
}

async function assertPursesMatchLedger(principalIds) {
  for (const principalId of principalIds) {
    const { rows } = await pool.query(`
      select coalesce((select balance from sharednet.credit_account where principal_id = $1), 0)::text as balance,
             coalesce(sum(case when to_principal_id = $1 then amount else 0 end
                        - case when from_principal_id = $1 then amount else 0 end), 0)::text as ledger
        from sharednet.credit_transfer
       where to_principal_id = $1 or from_principal_id = $1`, [principalId]);
    assert.equal(rows[0].balance, rows[0].ledger, `purse ${principalId} equals its full ledger, including a retired guest`);
  }
}

// Two logins prove possession of the same guest before either is approved.
// The second approver reads the guest before the winner commits, then waits.
{
  const seat = await raceGuest("claimed-once");
  await repository.transferCredits(visitor.auth, { to: seat.membership.instance_id, amount: 7 });
  const first = await repository.startCliLogin({ label: "first owner", seats: [seat.member_token] });
  const secondLogin = await repository.startCliLogin({ label: "second owner", seats: [seat.member_token] });
  const paused = gate();
  let intercepted = false;
  const contender = await controlledRepository({ before: async (statement) => {
    if (!intercepted && statement.includes("pg_advisory_xact_lock")) { intercepted = true; await paused.pause(); }
  } });
  try {
    const late = contender.repository.approveCliLogin({ code: secondLogin.user_code, principalId: visitor.principalId });
    await paused.arrived;
    const winner = await repository.approveCliLogin({ code: first.user_code, principalId: owner.principalId });
    assert.deepEqual(winner.bound_principal_ids, [seat.membership.principal_id]);
    paused.release();
    const result = await late;
    assert.deepEqual(result.bound_principal_ids, [], "a competing login cannot claim a guest already moved by the winner");
    const { rows } = await pool.query(`select i.principal_id, p.merged_into_principal_id
      from sharednet.instance i join sharednet.principal p on p.id = $1 where i.id = $2`,
      [seat.membership.principal_id, seat.membership.instance_id]);
    assert.deepEqual(rows[0], { principal_id: owner.principalId, merged_into_principal_id: owner.principalId }, "the seat and the retired Principal name the same winner");
    const paid = await repository.transferCredits(visitor.auth, { to: seat.membership.principal_id, amount: 2 });
    assert.equal(paid.transfer.to_principal_id, owner.principalId, "paying the retired guest id reaches its actual owner's purse");
    await assertPursesMatchLedger([owner.principalId, visitor.principalId, seat.membership.principal_id]);
  } finally { paused.release(); await contender.client.end(); }
}

// A multi-seat claim takes every identity lock before it moves its first seat.
// Pause after the high guest lock, then pay between the low and high guests.
// Locking each seat's pair separately creates a real low/high deadlock here.
{
  const seats = [await raceGuest("lock-low"), await raceGuest("lock-high")];
  // Use the exact binary order used by the repository, independent of locale.
  seats.sort((a, b) => a.membership.principal_id < b.membership.principal_id ? -1 : 1);
  const [low, high] = seats;
  await repository.transferCredits(visitor.auth, { to: low.membership.instance_id, amount: 10 });
  await repository.transferCredits(visitor.auth, { to: high.membership.instance_id, amount: 7 });
  const login = await repository.startCliLogin({ label: "many seats", seats: [high.member_token, low.member_token] });
  const before = (await repository.getCredits(owner.auth)).credits.balance;
  const paused = gate();
  let intercepted = false;
  const claimer = await controlledRepository({ after: async (statement, values) => {
    if (!intercepted && statement.includes("pg_advisory_xact_lock") && values[0] === `credits:${high.membership.principal_id}`) {
      intercepted = true; await paused.pause();
    }
  } });
  const payer = await controlledRepository();
  try {
    const claim = claimer.repository.approveCliLogin({ code: login.user_code, principalId: owner.principalId });
    const settledClaim = Promise.allSettled([claim]);
    await paused.arrived;
    const payment = payer.repository.transferCredits(low.auth, { to: high.membership.instance_id, amount: 3 });
    const settledPayment = Promise.allSettled([payment]);
    await waitForDatabaseLock(payer.pid);
    paused.release();
    const [claimResult] = await settledClaim;
    const [paymentResult] = await settledPayment;
    assert.equal(claimResult.status, "fulfilled", `multi-seat claim must not deadlock: ${claimResult.reason?.cause?.code ?? claimResult.reason?.code}`);
    assert.equal(paymentResult.status, "rejected", "the payment discovered two accounts that changed while it waited");
    assert.equal(paymentResult.reason.code, "credits_identity_moved", `identity movement is a retryable refusal, never a database deadlock: ${paymentResult.reason.cause?.code ?? paymentResult.reason.code}`);
    assert.equal((await repository.getCredits(owner.auth)).credits.balance, before + 17, "the owner received exactly both guest purses");
    for (const seat of seats) {
      assert.equal((await repository.getCredits(seat.auth)).credits.balance, 0, "each retired guest purse is empty");
      assert.equal((await repository.authenticateInstance(seat.member_token)).principalId, owner.principalId);
    }
    await assertPursesMatchLedger([owner.principalId, visitor.principalId, ...seats.map((seat) => seat.membership.principal_id)]);
  } finally { paused.release(); await claimer.client.end(); await payer.client.end(); }
}

// A payment that discovers a newly claimed payer or payee must refuse before
// trying to acquire the new owner's lock. Holding that lock makes the old
// second-lock-batch behavior observable, rather than relying on timing.
for (const direction of ["payer", "payee"]) {
  const seat = await raceGuest(`moving-${direction}`);
  await repository.transferCredits(visitor.auth, { to: seat.membership.instance_id, amount: 5 });
  const login = await repository.startCliLogin({ label: direction, seats: [seat.member_token] });
  const paused = gate();
  let intercepted = false;
  const payer = await controlledRepository({ before: async (statement) => {
    if (!intercepted && statement.includes("pg_advisory_xact_lock")) { intercepted = true; await paused.pause(); }
  } });
  const blocker = await controlledRepository();
  try {
    const payment = direction === "payer"
      ? payer.repository.transferCredits(seat.auth, { to: visitor.principalId, amount: 1 })
      : payer.repository.transferCredits(visitor.auth, { to: seat.membership.instance_id, amount: 1 });
    let completed = false;
    const settled = payment.then((value) => ({ value }), (error) => ({ error })).then((result) => { completed = true; return result; });
    await paused.arrived;
    await repository.approveCliLogin({ code: login.user_code, principalId: owner.principalId });
    await blocker.client.query("begin");
    await blocker.client.query("select pg_advisory_xact_lock(hashtext($1))", [`credits:${owner.principalId}`]);
    paused.release();
    const blocked = await waitForDatabaseLock(payer.pid, () => completed);
    await blocker.client.query("rollback");
    const result = await settled;
    assert.ok(!blocked, `a moved ${direction} is refused before taking an extra identity lock`);
    assert.equal(result.error?.code, "credits_identity_moved");
    await assertPursesMatchLedger([owner.principalId, visitor.principalId, seat.membership.principal_id]);
  } finally { paused.release(); await blocker.client.query("rollback"); await payer.client.end(); await blocker.client.end(); }
}

// The login itself remains single-use even when approvals overlap.
{
  const login = await repository.startCliLogin({ label: "one approval", seats: [] });
  const paused = gate();
  let intercepted = false;
  const first = await controlledRepository({ after: async (statement) => {
    if (!intercepted && statement.includes('"cli_login"') && statement.includes("for update")) { intercepted = true; await paused.pause(); }
  } });
  const secondApproval = await controlledRepository();
  try {
    const winner = first.repository.approveCliLogin({ code: login.user_code, principalId: owner.principalId });
    await paused.arrived;
    const loser = secondApproval.repository.approveCliLogin({ code: login.user_code, principalId: visitor.principalId });
    const refused = assert.rejects(loser, { code: "login_consumed", status: 410 });
    await waitForDatabaseLock(secondApproval.pid);
    paused.release();
    await winner;
    await refused;
    assert.equal((await repository.getCliLoginByCode(login.user_code)).login.principal_id, owner.principalId);
  } finally { paused.release(); await first.client.end(); await secondApproval.client.end(); }
}

// ---- A stable Instance owns its replay history across a guest claim. ----
function payThroughHandler(store, token, key, body) {
  return handleRequest(new Request("http://127.0.0.1/api/v1/credits/transfers", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  }), store);
}

{
  const seat = await raceGuest("replay-after-claim");
  await repository.transferCredits(visitor.auth, { to: seat.membership.instance_id, amount: 20 });
  const before = (await repository.getCredits(owner.auth)).credits.balance;
  const key = randomUUID();
  const body = { to: visitor.principalId, amount: 7 };
  const first = await payThroughHandler(repository, seat.member_token, key, body);
  const firstText = await first.text();
  assert.equal(first.status, 201);
  const login = await repository.startCliLogin({ label: "replay payer", seats: [seat.member_token] });
  await repository.approveCliLogin({ code: login.user_code, principalId: owner.principalId });
  const replay = await payThroughHandler(repository, seat.member_token, key, body);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true", "the same Instance replays its payment after its Principal changed");
  assert.equal(await replay.text(), firstText, "replay preserves the complete original response, including its original balance");
  const conflict = await payThroughHandler(repository, seat.member_token, key, { ...body, amount: 8 });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");
  assert.equal((await repository.getCredits(owner.auth)).credits.balance, before + 13, "a replay or conflict never spends from the claimed purse");
  const count = await pool.query("select count(*)::int as count from sharednet.credit_transfer where by_instance_id = $1", [seat.membership.instance_id]);
  assert.equal(count.rows[0].count, 1, "there is one payment by the claimed Instance");

  // Historical versions could leave one record in each Principal namespace.
  // Keep both intact and deterministically replay the earliest unexpired one.
  await pool.query("update sharednet.idempotency_record set created_at = now() - interval '2 minutes' where actor_id = $1 and idempotency_key = $2", [seat.membership.instance_id, key]);
  for (const [principalId, age, expired] of [[owner.principalId, "1 minute", false], [visitor.principalId, "2 days", true]]) {
    await pool.query(`insert into sharednet.idempotency_record
      (principal_id, credential_class, actor_id, operation_id, idempotency_key, request_fingerprint, response_status, response_body, created_at, expires_at)
      select $1, credential_class, actor_id, operation_id, idempotency_key, $4, response_status, '{"legacy":"different response"}',
             now() - $5::interval, case when $6 then now() - interval '1 minute' else expires_at end
        from sharednet.idempotency_record where principal_id = $2 and idempotency_key = $3`,
      [principalId, seat.membership.principal_id, key, createHash("sha256").update("another legacy body").digest("hex"), age, expired]);
  }
  const legacyReplay = await payThroughHandler(repository, seat.member_token, key, body);
  assert.equal(legacyReplay.headers.get("idempotency-replayed"), "true");
  assert.equal(await legacyReplay.text(), firstText, "an expired older row and a conflicting newer row cannot replace the first unexpired result");
  const legacyConflict = await payThroughHandler(repository, seat.member_token, key, { ...body, amount: 8 });
  assert.equal(legacyConflict.status, 409);
  assert.equal((await legacyConflict.json()).error.code, "idempotency_conflict");
  const preserved = await pool.query("select count(*)::int as count from sharednet.idempotency_record where actor_id = $1 and idempotency_key = $2", [seat.membership.instance_id, key]);
  assert.equal(preserved.rows[0].count, 2, "unexpired historical records are not rewritten or deleted");

  // Two real Instances in the same Principal may use the same key independently.
  const sibling = await repository.startInstance(ownerKeyAuth, { runtime_kind: "curl", cli_version: "0.1.6" });
  const independent = await payThroughHandler(repository, sibling.token, key, body);
  assert.equal(independent.status, 201);
  assert.equal(independent.headers.get("idempotency-replayed"), null);
  assert.notEqual((await independent.json()).transfer.id, JSON.parse(firstText).transfer.id);
  await assertPursesMatchLedger([owner.principalId, visitor.principalId, seat.membership.principal_id]);
}

// One caller authenticates before the claim; its twin authenticates after it.
// Keep the twin's payment uncommitted until the old caller reaches a real lock.
// They must contend for one stable scope, then return the same committed result.
{
  const seat = await raceGuest("inflight-claim-replay");
  await repository.transferCredits(visitor.auth, { to: seat.membership.instance_id, amount: 20 });
  const before = (await repository.getCredits(owner.auth)).credits.balance;
  const login = await repository.startCliLogin({ label: "inflight payer", seats: [seat.member_token] });
  const key = randomUUID();
  const body = { to: visitor.principalId, amount: 7 };
  const authenticated = gate();
  const beforeCommit = gate();
  let intercepted = false;
  const oldCaller = await controlledRepository({ before: async (statement, values) => {
    if (!intercepted && statement.includes("pg_advisory_xact_lock") && values[0]?.includes(key)) {
      intercepted = true; await authenticated.pause();
    }
  } });
  const newCaller = await controlledRepository({ after: async (statement) => {
    if (statement.startsWith('insert into "sharednet"."idempotency_record"')) await beforeCommit.pause();
  } });
  try {
    const oldRequest = payThroughHandler(oldCaller.repository, seat.member_token, key, body);
    await authenticated.arrived;
    await repository.approveCliLogin({ code: login.user_code, principalId: owner.principalId });
    const newRequest = payThroughHandler(newCaller.repository, seat.member_token, key, body);
    await beforeCommit.arrived;
    authenticated.release();
    await waitForDatabaseLock(oldCaller.pid);
    beforeCommit.release();
    const [original, replay] = await Promise.all([newRequest, oldRequest]);
    assert.equal(original.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotency-replayed"), "true", "a request authenticated before claim joins the stable in-flight replay scope");
    assert.equal(await replay.text(), await original.text());
    assert.equal((await repository.getCredits(owner.auth)).credits.balance, before + 13);
    const count = await pool.query("select count(*)::int as count from sharednet.credit_transfer where by_instance_id = $1", [seat.membership.instance_id]);
    assert.equal(count.rows[0].count, 1);
    await assertPursesMatchLedger([owner.principalId, visitor.principalId, seat.membership.principal_id]);
  } finally { authenticated.release(); beforeCommit.release(); await oldCaller.client.end(); await newCaller.client.end(); }
}

// A code this Principal already redeemed answers the same way once it expires.
await repository.mintCreditCode({ code: "SOON", amount: 3, expires_at: new Date(Date.now() + 60_000).toISOString() });
assert.equal((await repository.redeemCredits(owner.auth, "SOON")).granted, 3);
await pool.query(`update sharednet.credit_code set expires_at = now() - interval '1 minute' where code = 'SOON'`);
assert.equal((await repository.redeemCredits(owner.auth, "SOON")).granted, 0, "a settled redemption stays settled after the code expires");
await assert.rejects(repository.redeemCredits(visitor.auth, "SOON"), { code: "credit_code_expired" }, "someone who never redeemed it is told it expired");

// ---- Artifacts: a file handed to a Room, on real SQL. ----
const bytesOf = (text) => new TextEncoder().encode(text);
const patch = bytesOf("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n");
// `second` is the Room both accounts sit in by now.
const handed = await repository.uploadArtifact(owner.auth, {
  filename: "fix.patch",
  content_type: "text/plain",
  room_id: second.id,
  bytes: patch,
});
assert.match(handed.artifact.id, /^art_[0-9A-Za-z]{10}$/);
assert.match(handed.link_key, /^afk_[A-Za-z0-9_-]{43}$/, "every file has a link");
assert.deepEqual(
  [handed.artifact.size_bytes, handed.artifact.room_id, handed.artifact.uploaded_by_instance_id],
  [patch.byteLength, second.id, owner.instance.id],
);
assert.equal(handed.artifact.sha256, createHash("sha256").update(patch).digest("hex"));
// The bytes come back exactly, through the member's own seat.
const readBack = await repository.readArtifact(visitor.auth, handed.artifact.id);
assert.deepEqual([...readBack.bytes], [...patch], "the bytes survive the round trip");
// A Room this account does not sit in is not readable, and reads as absent.
const outsiderKey = await repository.authenticateApiKey(await (async () => {
  const key = `snk_${Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43)}`;
  const userId = `u_${randomUUID()}`;
  await pool.query(`insert into sharednet_auth."user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, false, now(), now())`, [userId, "outsider", `outsider-${userId}@example.test`]);
  await pool.query(`insert into sharednet_auth.apikey (id, name, reference_id, key, enabled, created_at, updated_at) values ($1, $2, $3, $4, true, now(), now())`, [`key_${randomUUID().replace(/-/g, "").slice(0, 10)}`, "outsider", userId, await defaultKeyHasher(key)]);
  return key;
})());
await assert.rejects(repository.getArtifact(outsiderKey, handed.artifact.id), { code: "artifact_not_found", status: 404 });
await assert.rejects(repository.readArtifact(outsiderKey, handed.artifact.id), { code: "artifact_not_found", status: 404 });
// Handing a file to a Room you do not sit in is refused as an absent Room.
await assert.rejects(
  repository.uploadArtifact(outsiderKey, { filename: "x.txt", content_type: "text/plain", room_id: second.id, bytes: bytesOf("x") }),
  { code: "room_not_found", status: 404 },
);
// Opened by its key alone; a wrong key, and another file's key, both refused the same way.
const published = await repository.uploadArtifact(owner.auth, {
  filename: "rows.csv",
  content_type: "text/csv",
  room_id: null,
  bytes: bytesOf("a,b\n1,2\n"),
});
assert.match(published.link_key, /^afk_[A-Za-z0-9_-]{43}$/);
assert.equal(published.artifact.room_id, null, "a file needs no Room");
const opened = await repository.readArtifactByLink(published.artifact.id, published.link_key);
assert.equal(new TextDecoder().decode(opened.bytes), "a,b\n1,2\n");
assert.equal(new TextDecoder().decode((await repository.readArtifactByLink(handed.artifact.id, handed.link_key)).bytes).length, patch.byteLength);
await assert.rejects(repository.readArtifactByLink(published.artifact.id, `afk_${"z".repeat(43)}`), { code: "artifact_not_found", status: 404 });
await assert.rejects(repository.readArtifactByLink(handed.artifact.id, published.link_key), { code: "artifact_not_found" }, "one key opens one file");
// A read never hands the key back out.
assert.equal("link_key" in (await repository.getArtifact(owner.auth, published.artifact.id)).artifact, false);
// Listing: the owner sees both, the member only the Room's.
assert.deepEqual((await repository.listArtifacts(owner.auth, { room_id: null, before: null, limit: 50 })).items.map((a) => a.filename), ["rows.csv", "fix.patch"]);
assert.deepEqual((await repository.listArtifacts(visitor.auth, { room_id: null, before: null, limit: 50 })).items.map((a) => a.filename), ["fix.patch"]);
assert.deepEqual((await repository.listArtifacts(outsiderKey, { room_id: null, before: null, limit: 50 })).items, []);
const firstPage = await repository.listArtifacts(owner.auth, { room_id: null, before: null, limit: 1 });
assert.equal(firstPage.has_more, true);
assert.deepEqual((await repository.listArtifacts(owner.auth, { room_id: null, before: firstPage.next_cursor, limit: 50 })).items.map((a) => a.filename), ["fix.patch"]);
await assert.rejects(repository.listArtifacts(owner.auth, { room_id: null, before: "art_nowhere01", limit: 10 }), { code: "invalid_cursor" });
// Usage counts what this account holds, and the empty and oversized are refused.
const usage = await repository.artifactUsage(owner.auth);
assert.equal(usage.count, 2);
assert.equal(usage.bytes, handed.artifact.size_bytes + published.artifact.size_bytes);
await assert.rejects(
  repository.uploadArtifact(owner.auth, { filename: "empty.txt", content_type: "text/plain", room_id: null, bytes: new Uint8Array() }),
  { code: "validation_failed", status: 422 },
);
await assert.rejects(
  repository.uploadArtifact(owner.auth, { filename: "big.bin", content_type: "application/octet-stream", room_id: null, bytes: new Uint8Array(4 * 1024 * 1024 + 1) }),
  { code: "artifact_too_large", status: 413 },
);
// Only the account that uploaded it may remove it; the bytes go with it.
await assert.rejects(repository.deleteArtifact(visitor.auth, handed.artifact.id), { code: "artifact_not_found", status: 404 });
assert.equal((await repository.deleteArtifact(owner.auth, handed.artifact.id)).artifact.id, handed.artifact.id);
await assert.rejects(repository.readArtifact(owner.auth, handed.artifact.id), { code: "artifact_not_found" });
const { rows: [orphans] } = await pool.query(`select count(*)::int as count from sharednet.artifact_bytes where artifact_id = $1`, [handed.artifact.id]);
assert.equal(orphans.count, 0, "removing a file removes its bytes");
// Closing a Room stops new files being handed to it.
await assert.rejects(
  repository.uploadArtifact(owner.auth, { filename: "late.txt", content_type: "text/plain", room_id: room.id, bytes: bytesOf("late") }),
  { code: "room_closed", status: 409 },
);

const { checkArtifactIdentity } = await import("./artifact-identity-postgres-checks.mjs");
await checkArtifactIdentity({ repository, pool, owner, visitor, account, raceGuest, gate, controlledRepository, waitForDatabaseLock, handleRequest });

// ---- Naming a seat, on real SQL: a note on someone else's, a nickname on your own. ----
// `second` holds the owner's seat and the visitor's private seat by now.
const roomAs = (principalId) => repository.getRoomForPrincipal(principalId, second.id);
assert.deepEqual((await roomAs(owner.principalId)).aliases, {});
// Someone else's seat: a note, and only the account that wrote it sees one.
assert.deepEqual(await repository.nameSeat(owner.principalId, privateSeat.instance.id, "Kai"), {
  instance_id: privateSeat.instance.id,
  name: "Kai",
  scope: "note",
});
assert.deepEqual((await roomAs(owner.principalId)).aliases, { [privateSeat.instance.id]: "Kai" });
assert.deepEqual((await roomAs(visitor.principalId)).aliases, {});
// Naming again replaces; naming with nothing forgets.
await repository.nameSeat(owner.principalId, privateSeat.instance.id, "Kai 2");
assert.deepEqual((await roomAs(owner.principalId)).aliases, { [privateSeat.instance.id]: "Kai 2" });
assert.equal((await repository.nameSeat(owner.principalId, privateSeat.instance.id, null)).name, null);
assert.deepEqual((await roomAs(owner.principalId)).aliases, {});
// Your own seat: a nickname, which every member of the Room reads off the seat.
const nickname = await repository.nameSeat(owner.principalId, owner.instance.id, "Xisen");
assert.deepEqual(nickname, { instance_id: owner.instance.id, name: "Xisen", scope: "nickname" });
assert.deepEqual((await roomAs(owner.principalId)).aliases, {}, "a nickname is not a note");
for (const principalId of [owner.principalId, visitor.principalId]) {
  const seen = (await roomAs(principalId)).memberships.find((member) => member.instance_id === owner.instance.id);
  assert.equal(seen.name, "Xisen", "everyone in the Room reads the nickname off the seat");
}
assert.equal((await repository.nameSeat(owner.principalId, owner.instance.id, null)).name, null);
assert.equal(
  (await roomAs(visitor.principalId)).memberships.find((member) => member.instance_id === owner.instance.id).name,
  null,
  "and it comes back off for everyone too",
);
// A seat this account shares no Room with is absent, so naming cannot probe ids.
await assert.rejects(repository.nameSeat(owner.principalId, "i_nowhere0001", "Nope"), { code: "instance_not_found", status: 404 });
const unseen = await repository.startInstance(await repository.authenticateApiKey(visitorKey), { runtime_kind: "codex", cli_version: "0.1.8" });
await assert.rejects(repository.nameSeat(owner.principalId, unseen.instance.id, "Nope"), { code: "instance_not_found", status: 404 });

await pool.end();
console.log(JSON.stringify({ status: "passed", room: room.id, scheduled: scheduled.room.id}));
