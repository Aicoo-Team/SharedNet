// @vitest-environment node

import { getTableName } from "drizzle-orm";
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

const PRINCIPAL = "p_ESSNaHrLYm";
const AGENT = "a_2xSwgdZOcI";
const INSTANCE = "i_u7x7i4uL6s";
const ROOM = "rom_lxw0rfaLIb";
const MESSAGE = "msg_H6egtDJW8q";
const DECISION = "dec_pqQbp2Md9a";

const NOW = new Date("2026-09-04T07:00:00.000Z");

const principalRow = { id: PRINCIPAL, authUserId: "auth-user-1", displayName: "Xisen", createdAt: NOW };
const agentRow = {
  id: AGENT, principalId: PRINCIPAL, handle: "reviewer", displayName: null,
  description: null, createdAt: NOW,
};
const instanceRow = {
  id: INSTANCE, principalId: PRINCIPAL, agentId: AGENT, issuedByKeyId: "key_x",
  tokenDigest: "d", runtimeKind: "codex", cliVersion: "0.1.0", state: "active",
  runtimeMetadata: { device_id: "dev-1", workspace: "/Users/x/proj/sharednet" }, localInstanceKey: null,
  startedAt: NOW, lastSeenAt: new Date(NOW.getTime() + 1_000), leaseExpiresAt: new Date(Date.now() + 60_000),
  tokenExpiresAt: new Date(Date.now() + 86_400_000), endedAt: null, revokedAt: null,
};
const roomRow = {
  id: ROOM, principalId: PRINCIPAL, name: "Hosted V1 migration", description: "seeded",
  state: "open", creatorInstanceId: INSTANCE, nextSequence: 3, createdAt: NOW,
};
const memberRow = {
  principalId: PRINCIPAL, roomId: ROOM, instanceId: INSTANCE,
  state: "active", joinedAt: NOW, leftAt: null, admittedBy: "room_id", addedByInstanceId: null,
};
const messageRow = {
  id: MESSAGE, roomId: ROOM, sequence: 1, senderPrincipalId: PRINCIPAL,
  senderInstanceId: INSTANCE, content: "first message",
  replyToMessageId: null, createdAt: NOW,
};
const decisionRow = {
  id: DECISION, principalId: PRINCIPAL, mode: "approval", title: "Deploy?",
  description: "Ship the migration", status: "pending",
  requestedByInstanceId: INSTANCE, roomId: ROOM, answer: null,
  createdAt: NOW, resolvedAt: null,
};

/**
 * Drives the client against a stubbed Drizzle surface. The point of these tests
 * is the projection shape the browser receives, so each one asserts with the
 * same predicate the client-side context uses to validate a real response.
 */
/**
 * One hoisted mock of the database module for the whole file. Swapping rows
 * through a mutable holder avoids resetModules()/doMock churn, which left the
 * real connection pool loaded and kept the vitest worker alive.
 */
const rowsByTable = vi.hoisted(() => ({ current: {} as Record<string, unknown[]> }));

vi.mock("@/packages/db/src/client.ts", () => {
  const makeChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {
      then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
    };
    for (const method of ["where", "orderBy", "limit", "for"]) {
      chain[method] = () => chain;
    }
    return chain;
  };

  const database: Record<string, unknown> = {
    // A transaction runs its body against the same stub; enough to prove the
    // client asks for one and does its writes inside it.
    transaction: async (body: (tx: unknown) => Promise<unknown>) => body(database),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          const name = getTableName(table);
          rowsByTable.current[name] = [...(rowsByTable.current[name] ?? []), row];
          return [row];
        },
      }),
    }),
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) =>
        makeChain(rowsByTable.current[getTableName(table)] ?? []),
    }),
    // Applies the patch to the table's first row: enough for a single-row
    // update, which is every update the client makes.
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            const name = getTableName(table);
            const rows = rowsByTable.current[name] ?? [];
            if (rows.length === 0) return [];
            const updated = { ...(rows[0] as Record<string, unknown>), ...patch };
            rowsByTable.current[name] = [updated, ...rows.slice(1)];
            return [updated];
          },
        }),
      }),
    }),
  };

  return { getDatabase: () => database };
});

/**
 * Room cases run on the memory repository: the same domain the API serves,
 * seeded through the API's own doors, so what the Dashboard shows is what an
 * Agent did. Network and Decision cases still drive the Drizzle stub below,
 * until their slice of the consolidation lands.
 */
const ACCOUNT = "auth-user-1";
type WebRoomId = Parameters<SharedNetServerClient["getRoom"]>[1];

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

function clientWith(tables: Record<string, unknown[]>) {
  // A copy, so an update in one test never leaks into the shared fixtures.
  rowsByTable.current = { ...tables };
  return new SharedNetServerClient();
}

// An Agent that joined with only an invite: an anonymous Principal of its own,
// an Instance admitted by the invite, and a seat recorded as such.
const GUEST_PRINCIPAL = "p_anonGuest1";
const GUEST_INSTANCE = "i_guest00001";
const guestPrincipalRow = {
  id: GUEST_PRINCIPAL, authUserId: null, displayName: "claude-code", createdAt: NOW,
  invitedByPrincipalId: PRINCIPAL, mergedIntoPrincipalId: null,
};
const guestInstanceRow = {
  id: GUEST_INSTANCE, principalId: GUEST_PRINCIPAL, agentId: null, issuedByKeyId: null,
  admittedByInviteId: "inv_invite0001", displayName: "claude-code",
  tokenDigest: "e".repeat(64), runtimeKind: "custom", cliVersion: "invite", state: "active",
  runtimeMetadata: {}, localInstanceKey: null,
  startedAt: NOW, lastSeenAt: new Date(Date.now() - 5_000), leaseExpiresAt: new Date(Date.now() + 60_000),
  tokenExpiresAt: null, endedAt: null, revokedAt: null,
};
const guestMemberRow = {
  principalId: GUEST_PRINCIPAL, roomId: ROOM, instanceId: GUEST_INSTANCE,
  state: "active", joinedAt: NOW, leftAt: null, admittedBy: "invite", inviteId: "inv_invite0001", addedByInstanceId: null,
};
const guestMessageRow = {
  id: "msg_guest000001", roomId: ROOM, sequence: 2, senderPrincipalId: GUEST_PRINCIPAL,
  senderInstanceId: GUEST_INSTANCE, senderGuestId: null, content: "hello from curl",
  replyToMessageId: null, createdAt: NOW,
};

const BASE_TABLES = {
  principal: [principalRow],
  agent: [agentRow],
  instance: [instanceRow],
  room: [roomRow],
  room_member: [memberRow],
  room_invite: [],
  message: [messageRow],
  decision: [decisionRow],
};

describe("SharedNetServerClient reads the V1 Postgres tables", () => {
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

  it("puts a Room's anonymous co-member on the Network as its own Principal, invited by me, with a Room edge", async () => {
    const client = clientWith({
      ...BASE_TABLES,
      principal: [principalRow, guestPrincipalRow],
      instance: [instanceRow, guestInstanceRow],
      room_member: [memberRow, guestMemberRow],
    });
    const network = await client.getNetwork("auth-user-1");

    expect(isNetworkProjection(network)).toBe(true);
    expect(network.principal.principal_id).toBe(PRINCIPAL);
    expect(network.connected_principals).toEqual([
      expect.objectContaining({
        principal_id: GUEST_PRINCIPAL,
        kind: "anonymous",
        diagnostic_label: "claude-code",
        summary: expect.stringContaining("invited by you"),
      }),
    ]);
    const seat = network.instances.find((instance) => instance.instance_id === GUEST_INSTANCE)!;
    expect(seat).toMatchObject({ principal_id: GUEST_PRINCIPAL, display_name: "claude-code", agent_id: null, runtime_type: "custom" });
    expect(network.edges).toEqual([
      { kind: "room_co_membership", source_id: GUEST_INSTANCE, target_id: INSTANCE, weight: 1 },
    ]);
    // Own tags are never marked discoverable; there is nothing of theirs to discover here.
    expect(network.agents.map((agent) => [agent.agent_id, agent.discoverability])).toEqual([[AGENT, false]]);
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

  it("projects Instances with lease-derived presence and no Runtime tier", async () => {
    const client = clientWith(BASE_TABLES);
    const network = await client.getNetwork("auth-user-1");

    expect(isNetworkProjection(network)).toBe(true);
    expect(network.instances).toHaveLength(1);
    expect(network.instances[0].presence).toBe("online");
    expect(network.instances[0].heartbeat_state).toBe("renewing");
    expect(network.instances[0]).not.toHaveProperty("runtime_id");
    expect(network).not.toHaveProperty("runtimes");
  });

  it("marks an instance offline once its presence lease has expired", async () => {
    const client = clientWith({
      ...BASE_TABLES,
      instance: [{ ...instanceRow, leaseExpiresAt: new Date(Date.now() - 1_000) }],
    });
    const network = await client.getNetwork("auth-user-1");

    expect(network.instances[0].presence).toBe("offline");
  });

  it("projects decisions and resolves a pending one", async () => {
    const client = clientWith(BASE_TABLES);
    const list = await client.listDecisions("auth-user-1");
    expect(list.decisions.every(isDecisionProjection)).toBe(true);

    const resolved = await client.resolveDecision(
      "auth-user-1",
      DECISION as never,
      { outcome: "approved" },
    );
    expect(isDecisionProjection(resolved)).toBe(true);
    expect(resolved.status).toBe("approved");
  });

  it("names the asker's own Principal on a seat request from another Principal", async () => {
    const asker = { ...instanceRow, id: "i_OtherSeat01", principalId: "p_OtherPrin01", agentId: null, localInstanceKey: null };
    const client = clientWith({
      ...BASE_TABLES,
      instance: [instanceRow, asker],
      decision: [{ ...decisionRow, requestedByInstanceId: "i_OtherSeat01", requestedForInstanceId: INSTANCE }],
    });
    const list = await client.listDecisions("auth-user-1");
    expect(list.decisions[0].requester).toEqual({ agent_id: null, instance_id: "i_OtherSeat01", principal_id: "p_OtherPrin01" });
    expect(list.decisions[0].requested_for_instance_id).toBe(INSTANCE);
    expect(list.decisions[0].target_principal_id).toBe(PRINCIPAL);
  });

  it("rejects a resolution that does not match the Decision mode", async () => {
    const client = clientWith(BASE_TABLES);
    await expect(
      client.resolveDecision("auth-user-1", DECISION as never, {
        outcome: "answered",
        responseText: "text for an approval Decision",
      }),
    ).rejects.toMatchObject({ code: "decision_resolution_invalid", status: 422 });
  });

  it("refuses to resolve a Decision twice", async () => {
    const client = clientWith({
      ...BASE_TABLES,
      decision: [{ ...decisionRow, status: "approved", resolvedAt: NOW }],
    });
    await expect(
      client.resolveDecision("auth-user-1", DECISION as never, { outcome: "approved" }),
    ).rejects.toMatchObject({ code: "decision_already_resolved", status: 409 });
  });

  it("reports pairing as retired rather than pretending to claim one", async () => {
    const client = clientWith(BASE_TABLES);
    await expect(
      client.claimPairing("auth-user-1", "pair_x" as never),
    ).rejects.toMatchObject({ code: "pairing_unsupported", status: 410 });
  });
});
