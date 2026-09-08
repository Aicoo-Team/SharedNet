// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemorySharedNetRepository } from "@/packages/server/src/memory-repository.ts";
import type { InstanceAuth, SharedNetRepository } from "@/packages/server/src/repository.ts";
import { SharedNetServerClient } from "./server-client";
import {
  isCloseRoomResponse,
  isCreateRoomInviteResponse,
  isDecisionProjection,
  isNetworkProjection,
  isRemoveRoomMemberResponse,
  isRoomDetail,
  isRoomListResponse,
  isRoomSummary,
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
    cli_version: "0.1.0",
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
      runtime: { kind: "codex", version: "0.1.0" },
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
    const started = await repository.startInstance(principalAuth, { runtime_kind: "codex", cli_version: "0.1.0", reach: "private" });
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

  it("reports pairing as retired rather than pretending to claim one", async () => {
    const client = new SharedNetServerClient(new MemorySharedNetRepository({ accounts: [{ authUserId: ACCOUNT }] }));
    await expect(client.claimPairing(ACCOUNT, "pair_x" as never)).rejects.toMatchObject({ code: "pairing_unsupported", status: 410 });
  });
});
