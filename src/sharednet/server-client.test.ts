// @vitest-environment node

import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SharedNetServerClient } from "./server-client";
import {
  isDecisionProjection,
  isNetworkProjection,
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
  state: "active", joinedAt: NOW, leftAt: null,
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
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => [
            { ...(rowsByTable.current.decision?.[0] ?? {}), ...patch },
          ],
        }),
      }),
    }),
  };

  return { getDatabase: () => database };
});

function clientWith(tables: Record<string, unknown[]>) {
  rowsByTable.current = tables;
  return new SharedNetServerClient();
}

const BASE_TABLES = {
  principal: [principalRow],
  agent: [agentRow],
  instance: [instanceRow],
  room: [roomRow],
  room_member: [memberRow],
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
