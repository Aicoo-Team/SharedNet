// @vitest-environment node

import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
    for (const method of ["where", "orderBy", "limit"]) {
      chain[method] = () => chain;
    }
    return chain;
  };

  const database = {
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
    const client = clientWith({ ...BASE_TABLES, principal: [] });
    await expect(client.listRooms("auth-user-1")).rejects.toMatchObject({
      code: "principal_not_found",
      status: 404,
    });
  });

  it("projects rooms in the shape the browser validates", async () => {
    const client = clientWith(BASE_TABLES);
    const result = await client.listRooms("auth-user-1");

    expect(isRoomListResponse(result)).toBe(true);
    expect(result.rooms[0]).toMatchObject({
      room_id: ROOM,
      latest_sequence: 2,
      latest_cursor: "cursor_2",
      member_count: 1,
      status: "open",
    });
  });

  it("schedules an empty Room owned by the Principal, with no creator Instance", async () => {
    const client = clientWith({ ...BASE_TABLES, room: [], room_member: [] });

    const created = await client.createRoom("auth-user-1", {
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
    expect(rowsByTable.current.room?.[0]).toMatchObject({
      creatorInstanceId: null,
      principalId: PRINCIPAL,
      state: "open",
    });
  });

  it("rejects a blank or over-long Room name before touching the database", async () => {
    const client = clientWith({ ...BASE_TABLES, room: [] });

    await expect(client.createRoom("auth-user-1", { name: "   " })).rejects.toMatchObject({
      code: "invalid_room_name",
      status: 400,
    });
    await expect(
      client.createRoom("auth-user-1", { name: "x".repeat(121) }),
    ).rejects.toMatchObject({ code: "invalid_room_name" });
    expect(rowsByTable.current.room).toEqual([]);
  });

  it("shows a scheduled Room to its owner before any Instance has joined", async () => {
    const scheduledRow = {
      ...roomRow, id: "rom_sched00001", name: "Scheduled", creatorInstanceId: null,
      nextSequence: 1,
    };
    const client = clientWith({ ...BASE_TABLES, room: [scheduledRow], room_member: [] });

    const list = await client.listRooms("auth-user-1");
    expect(isRoomListResponse(list)).toBe(true);
    expect(list.rooms.map((room) => room.room_id)).toEqual(["rom_sched00001"]);
    expect(list.rooms[0]).toMatchObject({ member_count: 0, owner_agent_ids: [] });

    const detail = await client.getRoom("auth-user-1", "rom_sched00001" as never);
    expect(isRoomDetail(detail)).toBe(true);
    expect(detail.room.creator).toEqual({ agent_id: null, principal_id: PRINCIPAL });
    expect(detail.memberships).toEqual([]);
  });

  it("still hides a Room the account neither owns nor joined", async () => {
    const foreignRow = {
      ...roomRow, id: "rom_foreign0001", principalId: "p_someoneElse", creatorInstanceId: null,
    };
    const client = clientWith({ ...BASE_TABLES, room: [foreignRow], room_member: [] });

    await expect(client.listRooms("auth-user-1")).resolves.toEqual({ rooms: [] });
    await expect(
      client.getRoom("auth-user-1", "rom_foreign0001" as never),
    ).rejects.toMatchObject({ code: "room_not_found", status: 404 });
  });

  it("projects room detail with senders resolved to V1 ids", async () => {
    const client = clientWith(BASE_TABLES);
    const detail = await client.getRoom("auth-user-1", ROOM as never);

    expect(isRoomDetail(detail)).toBe(true);
    expect(detail.messages[0].sender).toMatchObject({
      agent_id: AGENT,
      instance_id: INSTANCE,
      principal_id: PRINCIPAL,
    });
    expect(detail.room.creator.agent_id).toBe(AGENT);
  });

  it("mints a Room invite for the owner, returns the raw token once, and stores only its digest", async () => {
    const client = clientWith({ ...BASE_TABLES, room_invite: [] });

    const minted = await client.createRoomInvite("auth-user-1", ROOM as never);

    expect(isCreateRoomInviteResponse(minted)).toBe(true);
    expect(minted.token).toMatch(/^rit_[A-Za-z0-9_-]{43}$/);
    expect(minted.invite).toMatchObject({ room_id: ROOM, expires_at: null, revoked_at: null, uses: 0 });
    expect(minted.invite.invite_id).toMatch(/^inv_[0-9A-Za-z]{10}$/);
    const stored = rowsByTable.current.room_invite?.[0] as Record<string, unknown>;
    expect(stored.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(minted.token);
    expect(stored.expiresAt).toBeNull();
  });

  it("puts an expiry on an invite only when asked, and refuses a Room the account does not own", async () => {
    const client = clientWith({ ...BASE_TABLES, room_invite: [] });
    const timed = await client.createRoomInvite("auth-user-1", ROOM as never, {
      expires_in_seconds: 3600,
    });
    expect(timed.invite.expires_at).not.toBeNull();

    const foreign = clientWith({
      ...BASE_TABLES,
      room: [{ ...roomRow, principalId: "p_someoneElse" }],
      room_invite: [],
    });
    await expect(foreign.createRoomInvite("auth-user-1", ROOM as never)).rejects.toMatchObject({
      code: "room_not_found",
      status: 404,
    });
    expect(rowsByTable.current.room_invite).toEqual([]);
  });

  it("closes a Room the account owns, once, and reports it closed", async () => {
    const client = clientWith({ ...BASE_TABLES, room: [{ ...roomRow }] });

    const closed = await client.closeRoom("auth-user-1", ROOM as never);

    expect(isCloseRoomResponse(closed)).toBe(true);
    expect(closed.room).toMatchObject({ room_id: ROOM, status: "closed" });
    const stored = rowsByTable.current.room?.[0] as Record<string, unknown>;
    expect(stored.state).toBe("closed");
    expect(stored.closedAt).toBeInstanceOf(Date);

    // Closing again changes nothing and still answers with the closed Room.
    const again = await client.closeRoom("auth-user-1", ROOM as never);
    expect(again.room.status).toBe("closed");
    expect(again.room.updated_at).toBe(closed.room.updated_at);
  });

  it("refuses to close a Room the account does not own", async () => {
    const client = clientWith({
      ...BASE_TABLES,
      room: [{ ...roomRow, principalId: "p_someoneElse" }],
    });

    await expect(client.closeRoom("auth-user-1", ROOM as never)).rejects.toMatchObject({
      code: "room_not_found",
      status: 404,
    });
    expect((rowsByTable.current.room?.[0] as Record<string, unknown>).state).toBe("open");
  });

  it("removes an invite-admitted member: it leaves, keeps its name, and what it said stays", async () => {
    const client = clientWith({
      ...BASE_TABLES,
      principal: [principalRow, guestPrincipalRow],
      instance: [instanceRow, guestInstanceRow],
      // The stub updates a table's first row, so the seat being removed goes first.
      room_member: [{ ...guestMemberRow }, memberRow],
      message: [messageRow, guestMessageRow],
    });

    const removed = await client.removeRoomMember("auth-user-1", ROOM as never, GUEST_INSTANCE);

    expect(isRemoveRoomMemberResponse(removed)).toBe(true);
    expect(removed.membership).toMatchObject({
      kind: "guest",
      member_id: GUEST_INSTANCE,
      instance_id: GUEST_INSTANCE,
      name: "claude-code",
      status: "left",
    });
    expect(removed.membership.left_at).not.toBeNull();
    const detail = await client.getRoom("auth-user-1", ROOM as never);
    expect(detail.messages[1]!.sender).toEqual({
      agent_id: null,
      instance_id: expect.stringMatching(/^i_/),
      name: "claude-code",
      principal_id: GUEST_PRINCIPAL,
    });
  });

  it("removes an Instance member by its Instance id, and reports an unknown member", async () => {
    const client = clientWith({ ...BASE_TABLES, room_member: [{ ...memberRow }] });

    const removed = await client.removeRoomMember("auth-user-1", ROOM as never, INSTANCE);
    expect(isRemoveRoomMemberResponse(removed)).toBe(true);
    expect(removed.membership).toMatchObject({
      kind: "instance",
      instance_id: INSTANCE,
      member_id: INSTANCE,
      agent_id: AGENT,
      status: "left",
    });

    const empty = clientWith({ ...BASE_TABLES, room_member: [] });
    await expect(
      empty.removeRoomMember("auth-user-1", ROOM as never, "i_nobody00001"),
    ).rejects.toMatchObject({ code: "member_not_found", status: 404 });
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
    const client = clientWith({
      ...BASE_TABLES,
      principal: [principalRow, guestPrincipalRow],
      instance: [instanceRow, guestInstanceRow],
      room_member: [memberRow, guestMemberRow],
      message: [messageRow, guestMessageRow],
    });
    const detail = await client.getRoom("auth-user-1", ROOM as never);

    expect(isRoomDetail(detail)).toBe(true);
    expect(detail.memberships.map((member) => member.kind)).toEqual(["instance", "guest"]);
    const guest = detail.memberships[1]!;
    expect(guest).toMatchObject({
      instance_id: GUEST_INSTANCE,
      member_id: GUEST_INSTANCE,
      name: "claude-code",
      presence: "online",
      principal_id: GUEST_PRINCIPAL,
    });
    expect(detail.memberships[0]).toMatchObject({ kind: "instance", name: null, presence: "online" });
    expect(detail.messages[1]!.sender).toEqual({
      agent_id: null,
      instance_id: expect.stringMatching(/^i_/),
      name: "claude-code",
      principal_id: GUEST_PRINCIPAL,
    });
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
