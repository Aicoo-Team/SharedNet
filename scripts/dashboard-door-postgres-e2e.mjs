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

// A code this Principal already redeemed answers the same way once it expires.
await repository.mintCreditCode({ code: "SOON", amount: 3, expires_at: new Date(Date.now() + 60_000).toISOString() });
assert.equal((await repository.redeemCredits(owner.auth, "SOON")).granted, 3);
await pool.query(`update sharednet.credit_code set expires_at = now() - interval '1 minute' where code = 'SOON'`);
assert.equal((await repository.redeemCredits(owner.auth, "SOON")).granted, 0, "a settled redemption stays settled after the code expires");
await assert.rejects(repository.redeemCredits(visitor.auth, "SOON"), { code: "credit_code_expired" }, "someone who never redeemed it is told it expired");

await pool.end();
console.log(JSON.stringify({ status: "passed", room: room.id, scheduled: scheduled.room.id}));
