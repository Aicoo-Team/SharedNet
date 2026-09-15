// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemorySharedNetRepository } from "@/packages/server/src/memory-repository.ts";
import type { InstanceAuth, SharedNetRepository } from "@/packages/server/src/repository.ts";
import { SharedNetServerClient } from "./server-client";
import {
  isCloseRoomResponse,
  isCreateRoomInviteResponse,
  isCreditsProjection,
  isDecisionProjection,
  isNetworkProjection,
  isRemoveRoomMemberResponse,
  isRedeemCreditsResponse,
  isRoomDetail,
  isRoomListResponse,
  isRoomSummary,
  isShareRoomResponse,
  isSharedRoomProjection,
  isUnshareRoomResponse,
} from "./contracts";

/**
 * Every case runs the Web client on the memory repository: the same domain
 * the API serves, seeded through the API's own doors, so what the Dashboard
 * shows is what an Agent did. The Postgres side of the door is proved by
 * scripts/dashboard-door-postgres-e2e.mjs.
 */
const ACCOUNT = "auth-user-1";
type WebRoomId = Parameters<SharedNetServerClient["getRoom"]>[1];

/** A repository whose clock the test moves, for presence. */
function repositoryWithClock() {
  const clock = { now: new Date("2026-09-08T07:00:00.000Z") };
  const repository = new MemorySharedNetRepository({
    now: () => clock.now,
    accounts: [
      { authUserId: ACCOUNT, apiKey: "key-1", displayName: "Xisen" },
      { authUserId: "auth-user-2", apiKey: "key-2" },
    ],
  });
  return { repository, clock };
}

async function principalOf(client: SharedNetServerClient) {
  return { id: (await client.provisionAccount(ACCOUNT)).principal_id as string };
}

/** An account's Instance, registered with its API key the way the CLI does. */
async function seatFor(repository: SharedNetRepository, authUserId: string, apiKey: string, agent = false) {
  const principalAuth = (await repository.authenticateApiKey(apiKey))!;
  const agentId = agent ? (await repository.createAgent(principalAuth, { handle: `reviewer-${authUserId}` })).agent.id : null;
  const started = await repository.startInstance(principalAuth, {
    runtime_kind: "codex",
    cli_version: "0.1.3",
    agent_id: agentId,
    runtime_metadata: { device_id: "dev-1", workspace: "/Users/x/proj/sharednet" },
  });
  const auth = (await repository.authenticateInstance(started.token))!;
  return { auth, instance: started.instance };
}

/** One account, one Instance of it, one Room it opened with one message in it. */
async function seededRoom(options: { agent?: boolean } = {}) {
  const repository = new MemorySharedNetRepository({
    accounts: [
      { authUserId: ACCOUNT, apiKey: "key-1", displayName: "Xisen" },
      { authUserId: "auth-user-2", apiKey: "key-2" },
    ],
  });
  const client = new SharedNetServerClient(repository);
  const { auth, instance } = await seatFor(repository, ACCOUNT, "key-1", options.agent ?? false);
  const { room } = await repository.createRoom(auth, { name: "Hosted V1 migration", description: "seeded" });
  await repository.postMessage(auth, room.id, { content: "first message" });
  const principal = (await repository.principalForAccount(ACCOUNT))!;
  // The protocol and the Dashboard brand the same id string differently.
  return { repository, client, auth, instance, room, roomId: room.id as unknown as WebRoomId, principal };
}

/** An Agent with only an invite: it joins as a guest seat and says one thing. */
async function guestIn(client: SharedNetServerClient, repository: SharedNetRepository, roomId: string) {
  const minted = await client.createRoomInvite(ACCOUNT, roomId as never);
  const joined = await repository.joinRoomWithInvite(minted.token, roomId as never, {
    name: "claude-code",
    runtime: { kind: "claude-code", version: "1.0.0", source: "detected" },
  });
  const auth = (await repository.authenticateInstance(joined.member_token))! as InstanceAuth;
  await repository.postMessage(auth, roomId as never, { content: "hello from curl" });
  return { ...joined, auth };
}

describe("SharedNetServerClient is one door onto the domain", () => {
  it("projects an empty credit purse for an account and refuses an account with no Principal", async () => {
    const { repository } = repositoryWithClock();
    const client = new SharedNetServerClient(repository);
    const principal = (await repository.principalForAccount(ACCOUNT))!;

    const credits = await client.getCredits(ACCOUNT);
    expect(isCreditsProjection(credits)).toBe(true);
    expect(credits).toEqual({
      principal_id: principal.id,
      balance: 0,
      granted: 0,
      received: 0,
      sent: 0,
      transfers: [],
    });
    await expect(client.getCredits("absent-account")).rejects.toMatchObject({ code: "principal_not_found", status: 404 });
    await expect(client.redeemCredits("absent-account", "BFF-100")).rejects.toMatchObject({ code: "principal_not_found", status: 404 });
  });

  it("projects credit grants, payments and receipts from the signed-in account's side of the ledger", async () => {
    const { repository, clock } = repositoryWithClock();
    const client = new SharedNetServerClient(repository);
    const owner = await seatFor(repository, ACCOUNT, "key-1");
    const visitor = await seatFor(repository, "auth-user-2", "key-2");
    const { room } = await repository.createRoom(owner.auth, { name: "Trading round" });
    await repository.joinRoom(visitor.auth, room.id);
    await repository.mintCreditCode({ code: "BFF-100", amount: 100 });
    const grant = await client.redeemCredits(ACCOUNT, "BFF-100");
    expect(isRedeemCreditsResponse(grant)).toBe(true);

    clock.now = new Date("2026-09-08T07:01:00.000Z");
    const sent = await repository.transferCredits(owner.auth, { to: visitor.instance.id, amount: 30, memo: "map tiles", room_id: room.id });
    clock.now = new Date("2026-09-08T07:02:00.000Z");
    const received = await repository.transferCredits(visitor.auth, { to: owner.instance.id, amount: 5 });
    const credits = await client.getCredits(ACCOUNT);

    expect(isCreditsProjection(credits)).toBe(true);
    expect(credits).toMatchObject({ principal_id: owner.instance.principal_id, balance: 75, granted: 100, sent: 30, received: 5 });
    expect(credits.transfers).toEqual([
      {
        transfer_id: received.transfer.id,
        direction: "received",
        counterparty: visitor.instance.principal_id,
        addressed_to: owner.instance.id,
        amount: 5,
        by_instance_id: visitor.instance.id,
        code: null,
        memo: null,
        room_id: null,
        created_at: "2026-09-08T07:02:00.000Z",
      },
      {
        transfer_id: sent.transfer.id,
        direction: "sent",
        counterparty: visitor.instance.principal_id,
        addressed_to: visitor.instance.id,
        amount: 30,
        by_instance_id: owner.instance.id,
        code: null,
        memo: "map tiles",
        room_id: room.id,
        created_at: "2026-09-08T07:01:00.000Z",
      },
      {
        transfer_id: grant.credits.transfers[0]!.transfer_id,
        direction: "granted",
        counterparty: null,
        addressed_to: null,
        amount: 100,
        by_instance_id: null,
        code: "BFF-100",
        memo: null,
        room_id: null,
        created_at: "2026-09-08T07:00:00.000Z",
      },
    ]);
    const theirs = await client.getCredits("auth-user-2");
    expect(isCreditsProjection(theirs)).toBe(true);
    expect(theirs).toMatchObject({ principal_id: visitor.instance.principal_id, balance: 25, granted: 0, sent: 5, received: 30 });
    expect(theirs.transfers.map(({ transfer_id, direction }) => [transfer_id, direction])).toEqual([
      [received.transfer.id, "sent"],
      [sent.transfer.id, "received"],
    ]);
  });

  it("redeems a credit code once for each signed-in account and returns its updated purse", async () => {
    const { repository } = repositoryWithClock();
    const client = new SharedNetServerClient(repository);
    await repository.mintCreditCode({ code: "BFF-100", amount: 100 });

    const first = await client.redeemCredits(ACCOUNT, "BFF-100");
    const repeat = await client.redeemCredits(ACCOUNT, "BFF-100");
    const other = await client.redeemCredits("auth-user-2", "BFF-100");
    for (const result of [first, repeat, other]) expect(isRedeemCreditsResponse(result)).toBe(true);
    expect(first).toMatchObject({ granted: 100, credits: { balance: 100, granted: 100 } });
    expect(repeat).toEqual({ granted: 0, credits: first.credits });
    expect(other).toMatchObject({ granted: 100, credits: { balance: 100, granted: 100 } });
    expect(other.credits.principal_id).not.toBe(first.credits.principal_id);
    expect(other.credits.transfers).toHaveLength(1);
  });

  it("preserves a credit redemption refusal without changing the account's purse", async () => {
    const { repository } = repositoryWithClock();
    const client = new SharedNetServerClient(repository);
    const before = await client.getCredits(ACCOUNT);

    await expect(client.redeemCredits(ACCOUNT, "NO-SUCH-CODE")).rejects.toMatchObject({ code: "credit_code_not_found", status: 404 });
    await expect(client.getCredits(ACCOUNT)).resolves.toEqual(before);
  });

  it("fails closed when the account has no Principal", async () => {
    const client = new SharedNetServerClient(new MemorySharedNetRepository({ accounts: [] }));
    await expect(client.listRooms("auth-user-1")).rejects.toMatchObject({
      code: "principal_not_found",
      status: 404,
    });
  });

  it("projects rooms in the shape the browser validates", async () => {
    const { client, roomId, room } = await seededRoom();
    const result = await client.listRooms(ACCOUNT);

    expect(isRoomListResponse(result)).toBe(true);
    expect(result.rooms[0]).toMatchObject({
      room_id: room.id,
      latest_sequence: 1,
      latest_cursor: "cursor_1",
      member_count: 1,
      owner_agent_ids: [],
      status: "open",
    });
  });

  it("schedules an empty Room owned by the Principal, with no creator Instance", async () => {
    const repository = new MemorySharedNetRepository({ accounts: [{ authUserId: ACCOUNT }] });
    const client = new SharedNetServerClient(repository);

    const created = await client.createRoom(ACCOUNT, {
      description: "  Ship the launch review  ",
      name: "  Launch review  ",
    });

    expect(isRoomSummary(created)).toBe(true);
    expect(created).toMatchObject({
      description: "Ship the launch review",
      latest_sequence: 0,
      member_count: 0,
      name: "Launch review",
      owner_agent_ids: [],
      status: "open",
    });
    expect(created.room_id).toMatch(/^rom_[0-9A-Za-z]{10}$/);
    const principal = (await repository.principalForAccount(ACCOUNT))!;
    const { items } = await repository.listRoomsForPrincipal(principal.id);
    expect(items[0]!.room).toMatchObject({ id: created.room_id, creator_instance_id: null, principal_id: principal.id, state: "open" });
  });

  it("rejects a blank or over-long Room name before touching the domain", async () => {
    const repository = new MemorySharedNetRepository({ accounts: [{ authUserId: ACCOUNT }] });
    const client = new SharedNetServerClient(repository);

    await expect(client.createRoom(ACCOUNT, { name: "   " })).rejects.toMatchObject({
      code: "invalid_room_name",
      status: 400,
    });
    await expect(client.createRoom(ACCOUNT, { name: "x".repeat(121) })).rejects.toMatchObject({ code: "invalid_room_name" });
    await expect(client.listRooms(ACCOUNT)).resolves.toEqual({ rooms: [] });
  });

  it("shows a scheduled Room to its owner before any Instance has joined", async () => {
    const client = new SharedNetServerClient(new MemorySharedNetRepository({ accounts: [{ authUserId: ACCOUNT }] }));
    const scheduled = await client.createRoom(ACCOUNT, { name: "Scheduled" });

    const list = await client.listRooms(ACCOUNT);
    expect(isRoomListResponse(list)).toBe(true);
    expect(list.rooms.map((room) => room.room_id)).toEqual([scheduled.room_id]);
    expect(list.rooms[0]).toMatchObject({ member_count: 0, owner_agent_ids: [] });

    const detail = await client.getRoom(ACCOUNT, scheduled.room_id);
    expect(isRoomDetail(detail)).toBe(true);
    expect(detail.room.creator).toEqual({ agent_id: null, principal_id: (await principalOf(client)).id });
    expect(detail.memberships).toEqual([]);
  });

  it("still hides a Room the account neither owns nor joined", async () => {
    const { client, roomId, room } = await seededRoom();
    const stranger = "auth-user-2";

    await expect(client.listRooms(stranger)).resolves.toEqual({ rooms: [] });
    await expect(client.getRoom(stranger, roomId)).rejects.toMatchObject({ code: "room_not_found", status: 404 });
    await expect(client.closeRoom(stranger, roomId)).rejects.toMatchObject({ code: "room_not_found", status: 404 });
    await expect(client.createRoomInvite(stranger, roomId)).rejects.toMatchObject({ code: "room_not_found", status: 404 });
  });

  it("projects room detail with senders resolved to V1 ids", async () => {
    const { client, roomId, room, instance, principal } = await seededRoom({ agent: true });
    const detail = await client.getRoom(ACCOUNT, roomId);

    expect(isRoomDetail(detail)).toBe(true);
    expect(detail.messages[0]!.sender).toEqual({
      agent_id: instance.agent_id,
      instance_id: instance.id,
      principal_id: principal.id,
    });
    expect(detail.room.creator).toEqual({ agent_id: instance.agent_id, instance_id: instance.id, principal_id: principal.id });
    expect(detail.memberships[0]).toMatchObject({
      agent_id: instance.agent_id,
      admitted_by: "room_id",
      instance_id: instance.id,
      kind: "instance",
      presence: "online",
      runtime: { kind: "codex", version: "0.1.3" },
      status: "active",
    });
    expect(detail.next_cursor).toBe("cursor_1");
  });

  it("mints a Room invite for the owner, returns the raw token once, and describes it to the Agent that opens it", async () => {
    const { client, roomId, repository, room } = await seededRoom();

    const minted = await client.createRoomInvite(ACCOUNT, roomId);

    expect(isCreateRoomInviteResponse(minted)).toBe(true);
    expect(minted.token).toMatch(/^rit_[A-Za-z0-9_-]{43}$/);
    expect(minted.invite).toMatchObject({ room_id: room.id, expires_at: null, revoked_at: null, uses: 0 });
    expect(minted.invite.invite_id).toMatch(/^inv_[0-9A-Za-z]{10}$/);
    // The same token opens the same Room through the public API.
    await expect(repository.describeInvite(minted.token)).resolves.toMatchObject({ room: { id: room.id } });
  });

  it("puts an expiry on an invite only when asked, and refuses a Room the account does not own", async () => {
    const { client, roomId, room } = await seededRoom();
    const timed = await client.createRoomInvite(ACCOUNT, roomId, { expires_in_seconds: 3600 });
    expect(timed.invite.expires_at).not.toBeNull();
    await expect(client.createRoomInvite(ACCOUNT, roomId, { expires_in_seconds: -1 })).rejects.toMatchObject({
      code: "invalid_invite_expiry",
      status: 400,
    });

    // A Room another account's Instance opened is not the first account's to open a door into.
    const { repository } = await seededRoom();
    const client2 = new SharedNetServerClient(repository);
    const theirSeat = await seatFor(repository, "auth-user-2", "key-2");
    const { room: theirs } = await repository.createRoom(theirSeat.auth, { name: "Theirs" });
    await expect(client2.createRoomInvite(ACCOUNT, theirs.id as unknown as WebRoomId)).rejects.toMatchObject({
      code: "room_not_found",
      status: 404,
    });
  });

  it("revokes an invite of a Room the account owns, and reports one of another Room as absent", async () => {
    const { client, roomId, repository, room } = await seededRoom();
    const minted = await client.createRoomInvite(ACCOUNT, roomId);

    const revoked = await client.revokeRoomInvite(ACCOUNT, roomId, minted.invite.invite_id);
    expect(revoked.invite.revoked_at).not.toBeNull();
    await expect(repository.describeInvite(minted.token)).rejects.toMatchObject({ code: "invite_revoked" });

    const elsewhere = await client.createRoom(ACCOUNT, { name: "Elsewhere" });
    const second = await client.createRoomInvite(ACCOUNT, roomId);
    await expect(client.revokeRoomInvite(ACCOUNT, elsewhere.room_id, second.invite.invite_id)).rejects.toMatchObject({
      code: "room_not_found",
      status: 404,
    });
  });

  it("closes a Room the account owns, once, and reports it closed", async () => {
    const { client, roomId, repository, room, auth } = await seededRoom();

    const closed = await client.closeRoom(ACCOUNT, roomId);

    expect(isCloseRoomResponse(closed)).toBe(true);
    expect(closed.room).toMatchObject({ room_id: room.id, status: "closed" });
    // The seat's token stops working for this Room at once.
    await expect(repository.postMessage(auth, room.id, { content: "too late" })).rejects.toMatchObject({ code: "room_closed" });

    // Closing again changes nothing and still answers with the closed Room.
    const again = await client.closeRoom(ACCOUNT, roomId);
    expect(again.room.status).toBe("closed");
    expect(again.room.updated_at).toBe(closed.room.updated_at);
  });

  it("removes an invite-admitted member: it leaves, keeps its name, and what it said stays", async () => {
    const { client, roomId, repository, room, instance } = await seededRoom();
    const guest = await guestIn(client, repository, room.id);

    const removed = await client.removeRoomMember(ACCOUNT, roomId, guest.membership.instance_id);

    expect(isRemoveRoomMemberResponse(removed)).toBe(true);
    expect(removed.membership).toMatchObject({
      admitted_by: "invite",
      kind: "guest",
      member_id: guest.membership.instance_id,
      instance_id: guest.membership.instance_id,
      name: "claude-code",
      runtime: { kind: "claude-code", version: "1.0.0", source: "detected" },
      status: "left",
    });
    expect(removed.membership.left_at).not.toBeNull();
    // What the guest said stays, under its own anonymous Principal.
    const detail = await client.getRoom(ACCOUNT, roomId);
    expect(detail.messages[1]!.sender).toEqual({
      agent_id: null,
      instance_id: guest.membership.instance_id,
      name: "claude-code",
      principal_id: guest.membership.principal_id,
    });
    expect(detail.memberships.map((member) => [member.instance_id, member.status])).toEqual([
      [instance.id, "active"],
      [guest.membership.instance_id, "left"],
    ]);
    await expect(repository.postMessage(guest.auth, room.id, { content: "still here?" })).rejects.toMatchObject({ status: 403 });
  });

  it("removes an Instance member by its Instance id, and reports an unknown member", async () => {
    const { client, roomId, room, instance } = await seededRoom({ agent: true });

    const removed = await client.removeRoomMember(ACCOUNT, roomId, instance.id);
    expect(isRemoveRoomMemberResponse(removed)).toBe(true);
    expect(removed.membership).toMatchObject({
      kind: "instance",
      instance_id: instance.id,
      member_id: instance.id,
      agent_id: instance.agent_id,
      status: "left",
    });
    // Removing it again reports the seat as it is.
    const again = await client.removeRoomMember(ACCOUNT, roomId, instance.id);
    expect(again.membership).toMatchObject({ status: "left", left_at: removed.membership.left_at });

    await expect(client.removeRoomMember(ACCOUNT, roomId, "i_nobody00001")).rejects.toMatchObject({
      code: "member_not_found",
      status: 404,
    });
  });

  it("shows invite-admitted members of anonymous Principals by name, as their own senders", async () => {
    const { client, roomId, repository, room } = await seededRoom();
    const guest = await guestIn(client, repository, room.id);
    const detail = await client.getRoom(ACCOUNT, roomId);

    expect(isRoomDetail(detail)).toBe(true);
    expect(detail.memberships.map((member) => member.kind)).toEqual(["instance", "guest"]);
    expect(detail.memberships[1]).toMatchObject({
      admitted_by: "invite",
      instance_id: guest.membership.instance_id,
      member_id: guest.membership.instance_id,
      name: "claude-code",
      presence: "online",
      principal_id: guest.membership.principal_id,
    });
    expect(detail.memberships[0]).toMatchObject({ kind: "instance", name: null, presence: "online" });
    expect(detail.messages[1]!.sender).toEqual({
      agent_id: null,
      instance_id: guest.membership.instance_id,
      name: "claude-code",
      principal_id: guest.membership.principal_id,
    });
  });

  it("shows a Room the account sits in but did not schedule, and hides it again once its seat has left", async () => {
    const { client, roomId, repository, room } = await seededRoom();
    // A second account joins the first account's Room with its own Instance.
    const seated = await seatFor(repository, "auth-user-2", "key-2");
    await repository.joinRoom(seated.auth, room.id);
    const theirs = await client.listRooms("auth-user-2");
    expect(theirs.rooms.map((entry) => entry.room_id)).toEqual([room.id]);
    await expect(client.getRoom("auth-user-2", roomId)).resolves.toMatchObject({ room: { room_id: room.id } });
    // The owner may still not close or invite into it as the visitor.
    await expect(client.closeRoom("auth-user-2", roomId)).rejects.toMatchObject({ code: "room_not_found" });

    await client.removeRoomMember(ACCOUNT, roomId, seated.instance.id);
    await expect(client.getRoom("auth-user-2", roomId)).rejects.toMatchObject({ code: "room_not_found", status: 404 });
    await expect(client.listRooms("auth-user-2")).resolves.toEqual({ rooms: [] });
  });

  it("puts a Room's anonymous co-member on the Network as its own Principal, invited by me, with a Room edge", async () => {
    const { client, repository, room, instance, principal } = await seededRoom({ agent: true });
    const guest = await guestIn(client, repository, room.id);
    const network = await client.getNetwork(ACCOUNT);

    expect(isNetworkProjection(network)).toBe(true);
    expect(network.principal).toMatchObject({ principal_id: principal.id, kind: "human", diagnostic_label: "Xisen" });
    expect(network.connected_principals).toEqual([
      expect.objectContaining({
        principal_id: guest.membership.principal_id,
        kind: "anonymous",
        diagnostic_label: "claude-code",
        summary: expect.stringContaining("invited by you"),
      }),
    ]);
    const seat = network.instances.find((entry) => entry.instance_id === guest.membership.instance_id)!;
    expect(seat).toMatchObject({ principal_id: guest.membership.principal_id, display_name: "claude-code", agent_id: null, runtime_type: "claude-code" });
    expect(network.edges).toEqual([
      // Two seats in one Room of two: one shared Room, a whole connection.
      { kind: "room_co_membership", source_id: [instance.id, guest.membership.instance_id].sort()[0], target_id: [instance.id, guest.membership.instance_id].sort()[1], weight: 1, strength: 1 },
    ]);
    // Own tags are never marked discoverable; there is nothing of theirs to discover here.
    expect(network.agents.map((agent) => [agent.agent_id, agent.discoverability])).toEqual([[instance.agent_id, false]]);
  });

  it("shows another account's tag as discoverable only through a shared Room, and weights an edge by Rooms shared", async () => {
    const { client, repository, room, roomId, instance, auth } = await seededRoom();
    const other = await seatFor(repository, "auth-user-2", "key-2", true);
    await repository.joinRoom(other.auth, room.id);
    const { room: second } = await repository.createRoom(auth, { name: "Second", with: [other.instance.id] });

    const network = await client.getNetwork(ACCOUNT);
    expect(network.agents.map((agent) => [agent.principal_id, agent.discoverability])).toEqual([[other.instance.principal_id, true]]);
    expect(network.connected_principals.map((entry) => [entry.principal_id, entry.kind])).toEqual([[other.instance.principal_id, "human"]]);
    expect(network.edges).toEqual([expect.objectContaining({ weight: 2 })]);
    expect(network.instances.map((entry) => entry.instance_id).sort()).toEqual([instance.id, other.instance.id].sort());

    // Once its seats are gone, so is the other account: nothing else is discoverable.
    await client.removeRoomMember(ACCOUNT, roomId, other.instance.id);
    await client.removeRoomMember(ACCOUNT, second.id as unknown as WebRoomId, other.instance.id);
    const alone = await client.getNetwork(ACCOUNT);
    expect(alone.agents).toEqual([]);
    expect(alone.connected_principals).toEqual([]);
    expect(alone.edges).toEqual([]);
  });

  it("projects Instances with lease-derived presence and no Runtime tier, and marks one offline once its lease lapsed", async () => {
    const { repository, clock } = repositoryWithClock();
    const client = new SharedNetServerClient(repository);
    const { instance } = await seatFor(repository, ACCOUNT, "key-1");

    const live = await client.getNetwork(ACCOUNT);
    expect(isNetworkProjection(live)).toBe(true);
    expect(live.instances).toHaveLength(1);
    expect(live.instances[0]).toMatchObject({ instance_id: instance.id, presence: "online", heartbeat_state: "renewing", status: "online", workspace_label: "sharednet" });
    expect(live.instances[0]).not.toHaveProperty("runtime_id");
    expect(live).not.toHaveProperty("runtimes");

    clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    const later = await client.getNetwork(ACCOUNT);
    expect(later.instances[0]).toMatchObject({ presence: "offline", heartbeat_state: "never_started", status: "online" });
  });

  /** A private Instance of account 2, asked for by account 1's Instance: a pending Decision for account 2. */
  async function seatRequest() {
    const { client, repository, room, roomId, auth, instance } = await seededRoom();
    const principalAuth = (await repository.authenticateApiKey("key-2"))!;
    const started = await repository.startInstance(principalAuth, { runtime_kind: "codex", cli_version: "0.1.3", reach: "private" });
    const { admissions } = await repository.addRoomMembers(auth, room.id, { with: [started.instance.id] });
    expect(admissions).toEqual([{ instance_id: started.instance.id, status: "pending", decision_id: expect.stringMatching(/^dec_/) }]);
    return { client, repository, room, roomId, asker: instance, target: started.instance, decisionId: admissions[0]!.decision_id! };
  }

  it("lists a seat request for the deciding account, naming the asker's own Principal, and seats the Instance on approval", async () => {
    const { client, room, roomId, asker, target, decisionId } = await seatRequest();

    const list = await client.listDecisions("auth-user-2");
    expect(list.decisions.every(isDecisionProjection)).toBe(true);
    expect(list.decisions[0]).toMatchObject({
      decision_id: decisionId,
      status: "pending",
      response_mode: "approval",
      requester: { agent_id: null, instance_id: asker.id, principal_id: asker.principal_id },
      requested_for_instance_id: target.id,
      room_id: room.id,
      target_principal_id: target.principal_id,
    });
    // The asking account has no such Decision: it is addressed to the other one.
    await expect(client.listDecisions(ACCOUNT)).resolves.toEqual({ decisions: [] });
    await expect(client.resolveDecision(ACCOUNT, decisionId as never, { outcome: "approved" })).rejects.toMatchObject({ code: "decision_not_found", status: 404 });

    const resolved = await client.resolveDecision("auth-user-2", decisionId as never, { outcome: "approved" });
    expect(isDecisionProjection(resolved)).toBe(true);
    expect(resolved).toMatchObject({ status: "approved", resolved_at: expect.any(String) });
    // The seat was written with the approval, and the Room is now visible to account 2.
    const detail = await client.getRoom("auth-user-2", roomId);
    expect(detail.memberships.map((member) => [member.instance_id, member.admitted_by, member.added_by_instance_id])).toEqual([
      [asker.id, "room_id", null],
      [target.id, "accepted", asker.id],
    ]);
  });

  it("rejects a resolution that does not match the Decision mode, and refuses to resolve twice", async () => {
    const { client, decisionId } = await seatRequest();
    await expect(
      client.resolveDecision("auth-user-2", decisionId as never, { outcome: "answered", responseText: "text for an approval Decision" }),
    ).rejects.toMatchObject({ code: "decision_resolution_invalid", status: 422 });

    const denied = await client.resolveDecision("auth-user-2", decisionId as never, { outcome: "denied" });
    expect(denied.status).toBe("denied");
    await expect(client.resolveDecision("auth-user-2", decisionId as never, { outcome: "approved" })).rejects.toMatchObject({
      code: "decision_already_resolved",
      status: 409,
    });
  });

  it("refuses to seat an approved Instance in a Room that closed meanwhile, the way the API does", async () => {
    const { client, roomId, decisionId } = await seatRequest();
    await client.closeRoom(ACCOUNT, roomId);
    await expect(client.resolveDecision("auth-user-2", decisionId as never, { outcome: "approved" })).rejects.toMatchObject({
      code: "room_closed",
      status: 409,
    });
    expect((await client.listDecisions("auth-user-2")).decisions[0]!.status).toBe("pending");
  });

  it("shows the approve page the seats a CLI login would bind, with their Rooms", async () => {
    const { client, repository, room } = await seededRoom();
    const guest = await guestIn(client, repository, room.id);
    // A seat is proved by possession of its token; the login records the Instance behind it.
    const { login, user_code } = await repository.startCliLogin({ label: "laptop", seats: [guest.member_token] });

    const shown = await client.getCliLogin(ACCOUNT, user_code);
    expect(shown).toMatchObject({ login_id: login.id, state: "pending", label: "laptop" });
    expect(shown.seats).toEqual([{ instance_id: guest.membership.instance_id, name: "claude-code", runtime_kind: "claude-code", rooms: [{ room_id: room.id, name: room.name }] }]);
  });

  it("publishes a Room its owner shares at a slug that is not the Room id, shows the owner the link, and a seat only that it is public", async () => {
    const { repository, client, roomId, room } = await seededRoom({ agent: true });
    const visitor = await seatFor(repository, "auth-user-2", "key-2");
    await repository.joinRoom(visitor.auth, room.id);

    expect((await client.getRoom(ACCOUNT, roomId)).room.sharing).toBeNull();
    const shared = await client.shareRoom(ACCOUNT, roomId);
    expect(isShareRoomResponse(shared)).toBe(true);
    expect(shared.token).toMatch(/^shr_[A-Za-z0-9_-]{43}$/);
    expect(shared.token).not.toContain(room.id);
    expect(shared.room.sharing).toEqual({ since: expect.any(String), token: shared.token });
    // Asking again is the same link, not a new one.
    expect((await client.shareRoom(ACCOUNT, roomId)).token).toBe(shared.token);
    expect((await client.getRoom(ACCOUNT, roomId)).room.sharing?.token).toBe(shared.token);
    // A seated account learns that the Room is public, not where.
    expect((await client.getRoom("auth-user-2", roomId)).room.sharing).toEqual({ since: shared.room.sharing?.since, token: null });
    // Only the owner shares or stops sharing.
    await expect(client.shareRoom("auth-user-2", roomId)).rejects.toMatchObject({ code: "room_not_found", status: 404 });
    await expect(client.unshareRoom("auth-user-2", roomId)).rejects.toMatchObject({ code: "room_not_found", status: 404 });

    const stopped = await client.unshareRoom(ACCOUNT, roomId);
    expect(isUnshareRoomResponse(stopped)).toBe(true);
    expect(stopped.room.sharing).toBeNull();
    await expect(client.getSharedRoom(shared.token)).rejects.toMatchObject({ code: "room_not_found", status: 404 });
    // Sharing again mints a new link; the old one stays dead.
    const again = await client.shareRoom(ACCOUNT, roomId);
    expect(again.token).not.toBe(shared.token);
    await expect(client.getSharedRoom(shared.token)).rejects.toMatchObject({ code: "room_not_found" });
    expect(isSharedRoomProjection(await client.getSharedRoom(again.token))).toBe(true);
  });

  it("shows the public the log by names, drivers and sequence numbers, with no ids and no credentials", async () => {
    const { repository, client, auth, roomId, room, instance } = await seededRoom({ agent: true });
    const guest = await guestIn(client, repository, roomId);
    const invite = await client.createRoomInvite(ACCOUNT, roomId);
    const [first] = (await repository.listMessages(auth, room.id, { after: 0, before: null, limit: 1, order: "asc", sender_instance_id: null, sender_agent_id: null, q: null })).items;
    await repository.postMessage(auth, room.id, {
      content: `join with ROOM=${room.id} TOKEN=${invite.token} BASE=https://www.sharednet.ai --claim clp_${"c".repeat(43)}`,
      reply_to_message_id: first!.id,
    });
    const { token } = await client.shareRoom(ACCOUNT, roomId);

    const shared = await client.getSharedRoom(token);
    expect(isSharedRoomProjection(shared)).toBe(true);
    expect(shared.room).toMatchObject({ name: "Hosted V1 migration", description: "seeded", status: "open", latest_sequence: 3 });
    expect(shared.members.map((m) => [m.label, m.driver, m.kind, m.handle, m.status])).toEqual([
      [`reviewer-${ACCOUNT}`, "codex", "account", instance.id.slice(2, 6), "active"],
      ["claude-code", "claude-code", "anonymous", guest.membership.instance_id.slice(2, 6), "active"],
    ]);
    expect(shared.messages.map((m) => [m.sequence, m.sender.label, m.reply_to_sequence, m.content])).toEqual([
      [1, `reviewer-${ACCOUNT}`, null, "first message"],
      [2, "claude-code", null, "hello from curl"],
      [3, `reviewer-${ACCOUNT}`, 1, "join with ROOM=rom_[redacted] TOKEN=rit_[redacted] BASE=https://www.sharednet.ai --claim clp_[redacted]"],
    ]);
    // Nothing that addresses anything leaves the server: no Room, Instance, Principal or message id,
    // not even the Room id an Agent itself pasted, since that one admits.
    const wire = JSON.stringify(shared);
    expect(wire).not.toMatch(/\b(rom|i|p|msg|inv)_[0-9A-Za-z]{10}\b/);
    expect(wire).not.toContain(invite.token);
    // A slug that is not one, and a slug nobody minted, both read as absent.
    await expect(client.getSharedRoom(room.id)).rejects.toMatchObject({ code: "room_not_found", status: 404 });
    await expect(client.getSharedRoom(`shr_${"z".repeat(43)}`)).rejects.toMatchObject({ code: "room_not_found", status: 404 });
  });

  it("publishes a closed Room too, since a finished conversation is the one worth showing", async () => {
    const { client, roomId } = await seededRoom();
    await client.closeRoom(ACCOUNT, roomId);
    const { token, room } = await client.shareRoom(ACCOUNT, roomId);
    expect(room.status).toBe("closed");
    expect((await client.getSharedRoom(token)).room.status).toBe("closed");
  });

  it("gives your own seat a nickname the Room sees, and someone else's a note only you see", async () => {
    const { repository, client, auth, roomId, room, instance } = await seededRoom();
    const visitor = await seatFor(repository, "auth-user-2", "key-2");
    await repository.joinRoom(visitor.auth, room.id);
    await repository.postMessage(visitor.auth, room.id, { content: "second" });

    // Until it is named, the Room carries no name for that seat.
    expect((await client.getRoom(ACCOUNT, roomId)).notes).toEqual({});

    const named = await client.nameSeat(ACCOUNT, visitor.instance.id as never, "Kai");
    expect(named).toEqual({ instance_id: visitor.instance.id, name: "Kai", scope: "note" });
    expect((await client.getRoom(ACCOUNT, roomId)).notes).toEqual({ [visitor.instance.id]: "Kai" });
    // It is this account's name and nobody else's: the other side sees none.
    expect((await client.getRoom("auth-user-2", roomId)).notes).toEqual({});
    // Naming again replaces it; naming with nothing forgets it.
    expect((await client.nameSeat(ACCOUNT, visitor.instance.id as never, "Kai 2")).name).toBe("Kai 2");
    expect((await client.getRoom(ACCOUNT, roomId)).notes).toEqual({ [visitor.instance.id]: "Kai 2" });
    expect((await client.nameSeat(ACCOUNT, visitor.instance.id as never, null)).name).toBeNull();
    expect((await client.getRoom(ACCOUNT, roomId)).notes).toEqual({});

    // Naming your own seat is a nickname instead: it is not a note, and the
    // whole Room sees it — including the account that did not write it.
    const nickname = await client.nameSeat(ACCOUNT, instance.id as never, "Xisen");
    expect(nickname).toEqual({ instance_id: instance.id, name: "Xisen", scope: "nickname" });
    expect((await client.getRoom(ACCOUNT, roomId)).notes).toEqual({});
    const asMe = await client.getRoom(ACCOUNT, roomId);
    const asThem = await client.getRoom("auth-user-2", roomId);
    for (const seen of [asMe, asThem]) {
      expect(seen.memberships.find((member) => member.instance_id === instance.id)?.name).toBe("Xisen");
    }
    // And it comes back off the same way.
    expect((await client.nameSeat(ACCOUNT, instance.id as never, null)).name).toBeNull();
    expect((await client.getRoom("auth-user-2", roomId)).memberships.find((member) => member.instance_id === instance.id)?.name).toBeNull();

    // A seat this account shares no Room with reads as absent, so naming one
    // cannot be used to find out whether an Instance id is real.
    const stranger = await seatFor(repository, "auth-user-2", "key-2");
    await expect(client.nameSeat(ACCOUNT, stranger.instance.id as never, "Nope")).rejects.toMatchObject({
      code: "instance_not_found",
      status: 404,
    });
    await expect(client.nameSeat(ACCOUNT, "i_nowhere0001" as never, "Nope")).rejects.toMatchObject({
      code: "instance_not_found",
      status: 404,
    });
  });

  it("reports pairing as retired rather than pretending to claim one", async () => {
    const client = new SharedNetServerClient(new MemorySharedNetRepository({ accounts: [{ authUserId: ACCOUNT }] }));
    await expect(client.claimPairing(ACCOUNT, "pair_x" as never)).rejects.toMatchObject({ code: "pairing_unsupported", status: 410 });
  });
});
