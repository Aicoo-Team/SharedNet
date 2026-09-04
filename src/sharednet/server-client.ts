import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "@/packages/db/src/client.ts";
import {
  agents,
  decisions,
  instances,
  messages,
  principals,
  roomMembers,
  rooms,
} from "@/packages/db/src/schema.ts";

import {
  type ActorProjection,
  type AgentId,
  type AgentProjection,
  type DecisionId,
  type DecisionListResponse,
  type DecisionProjection,
  type DecisionResolution,
  type InstanceId,
  type InstanceProjection,
  type NetworkEdge,
  type NetworkProjection,
  type PairingId,
  type PrincipalId,
  type PrincipalProjection,
  type ProvisionAccountResponse,
  type RoomCursor,
  type RoomDetail,
  type RoomId,
  type RoomListResponse,
  type RoomMembership,
  type RoomMessage,
  type RoomSummary,
} from "./contracts";

/**
 * The account Dashboard reads the same PostgreSQL tables the V1 API writes.
 *
 * The browser never holds an snk_/sni_ bearer token: pages authenticate with the
 * Better Auth session cookie, the route handler resolves that to an auth user
 * id, and this module scopes every query to that user's Principal. There is no
 * second service and no console token — the Dashboard and the V1 API are two
 * views onto one database.
 */
export class SharedNetApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SharedNetApiError";
    this.code = code;
    this.status = status;
  }
}

/** Presence lease, mirrored from packages/server/src/repository.ts. */
const PRESENCE_LEASE_GRACE_MS = 0;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requiredIso(value: Date | string): string {
  return iso(value) as string;
}

function cursor(sequence: number): RoomCursor {
  return `cursor_${sequence}` as RoomCursor;
}

/**
 * Presence is a lease, not a flag. An Instance counts as online only while
 * something is actively renewing it through the heartbeat endpoint; the lease
 * is PRESENCE_LEASE_MS wide, so a session that registers and stops calling goes
 * offline shortly after. heartbeat_state separates the two ways an Instance can
 * be offline, because "nothing ever drove this" and "the driver stopped" look
 * identical otherwise.
 */
function presenceOf(
  instance: {
    state: string;
    leaseExpiresAt: Date | string;
    lastSeenAt: Date | string;
    startedAt: Date | string;
  },
  now: number,
): { presence: "online" | "offline"; heartbeat_state: "renewing" | "never_started" | "stopped" } {
  const ms = (value: Date | string) =>
    value instanceof Date ? value.getTime() : Date.parse(String(value));

  if (instance.state === "active" && ms(instance.leaseExpiresAt) > now) {
    return { presence: "online", heartbeat_state: "renewing" };
  }
  // lastSeenAt only advances on heartbeat, so an Instance still carrying its
  // registration timestamp was never driven by anything.
  const neverRenewed = ms(instance.lastSeenAt) <= ms(instance.startedAt);
  return {
    presence: "offline",
    heartbeat_state: neverRenewed ? "never_started" : "stopped",
  };
}

function principalProjection(row: {
  id: string;
  displayName: string | null;
  createdAt: Date | string;
}): PrincipalProjection {
  return {
    created_at: requiredIso(row.createdAt),
    diagnostic_label: row.displayName ?? "SharedNet Principal",
    kind: "human",
    principal_id: row.id as PrincipalId,
    summary: "SharedNet account Principal",
  };
}

function agentProjection(row: {
  id: string;
  principalId: string;
  handle: string;
  displayName: string | null;
  description: string | null;
  isDefault: boolean;
  createdAt: Date | string;
}): AgentProjection {
  return {
    agent_id: row.id as AgentId,
    created_at: requiredIso(row.createdAt),
    diagnostic_label: row.displayName ?? `@${row.handle}`,
    discoverability: false,
    official: row.isDefault,
    principal_id: row.principalId as PrincipalId,
    role: row.isDefault ? "default" : "agent",
    summary: row.description ?? `Agent @${row.handle}`,
  };
}

function actor(
  agentId: string,
  principalId: string,
  instanceId?: string,
): ActorProjection {
  const projection: ActorProjection = {
    agent_id: agentId as AgentId,
    principal_id: principalId as PrincipalId,
  };
  if (instanceId !== undefined) {
    projection.instance_id = instanceId as InstanceId;
  }
  return projection;
}

export class SharedNetServerClient {
  private database() {
    return getDatabase();
  }

  /** Resolve the Principal this Better Auth user owns, or fail closed. */
  private async requirePrincipal(authUserId: string) {
    const [row] = await this.database()
      .select()
      .from(principals)
      .where(eq(principals.authUserId, authUserId))
      .limit(1);

    if (!row) {
      throw new SharedNetApiError("principal_not_found", 404, "No Principal for this account");
    }
    return row;
  }

  async provisionAccount(authUserId: string): Promise<ProvisionAccountResponse> {
    const principal = await this.requirePrincipal(authUserId);
    return { principal_id: principal.id as PrincipalId };
  }

  /**
   * Pairing was a Python-era flow for claiming a machine into an account. V1
   * registers Instances with an API key instead, so there is nothing to claim.
   */
  async claimPairing(_authUserId: string, _pairingId: PairingId): Promise<never> {
    throw new SharedNetApiError(
      "pairing_unsupported",
      410,
      "Pairing was retired with the Python daemon; register an Instance with an API key instead",
    );
  }

  async listRooms(authUserId: string): Promise<RoomListResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const database = this.database();

    const roomRows = await database
      .select()
      .from(rooms)
      .where(eq(rooms.principalId, principal.id))
      .orderBy(desc(rooms.createdAt));

    if (roomRows.length === 0) return { rooms: [] };

    const roomIds = roomRows.map((row) => row.id);
    const memberRows = await database
      .select()
      .from(roomMembers)
      .where(inArray(roomMembers.roomId, roomIds));

    const summaries: RoomSummary[] = roomRows.map((room) => {
      const members = memberRows.filter((member) => member.roomId === room.id);
      const latestSequence = room.nextSequence - 1;
      return {
        description: room.description,
        latest_cursor: cursor(latestSequence),
        latest_sequence: latestSequence,
        member_count: members.filter((member) => member.state === "active").length,
        name: room.name,
        owner_agent_ids: [room.creatorAgentId as AgentId],
        room_id: room.id as RoomId,
        status: room.state,
        updated_at: requiredIso(room.createdAt),
      };
    });

    return { rooms: summaries };
  }

  async getRoom(authUserId: string, roomId: RoomId): Promise<RoomDetail> {
    const principal = await this.requirePrincipal(authUserId);
    const database = this.database();

    const [room] = await database
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, roomId as never), eq(rooms.principalId, principal.id)))
      .limit(1);

    if (!room) {
      throw new SharedNetApiError("room_not_found", 404, "Room not found");
    }

    const [memberRows, messageRows] = await Promise.all([
      database.select().from(roomMembers).where(eq(roomMembers.roomId, room.id)),
      database
        .select()
        .from(messages)
        .where(eq(messages.roomId, room.id))
        .orderBy(asc(messages.sequence)),
    ]);


    const memberships: RoomMembership[] = memberRows.map((member) => ({
      agent_id: member.agentId as AgentId,
      instance_id: member.instanceId as InstanceId,
      joined_at: requiredIso(member.joinedAt),
      last_read_sequence: 0,
      left_at: iso(member.leftAt),
      principal_id: member.principalId as PrincipalId,
      room_id: member.roomId as RoomId,
      status: member.state,
    }));

    const projectedMessages: RoomMessage[] = messageRows.map((message) => ({
      attachment_ids: [],
      content: message.content,
      created_at: requiredIso(message.createdAt),
      message_id: message.id as RoomMessage["message_id"],
      reply_to: (message.replyToMessageId ?? null) as RoomMessage["reply_to"],
      resolution_state: "not_required",
      room_id: message.roomId as RoomId,
      sender: actor(
        message.senderAgentId,
        message.senderPrincipalId,
        message.senderInstanceId,
      ),
      sequence: message.sequence,
      tags: [],
    }));

    return {
      memberships,
      messages: projectedMessages,
      next_cursor: cursor(room.nextSequence - 1),
      room: {
        access_policy: "principal_only",
        created_at: requiredIso(room.createdAt),
        creator: actor(room.creatorAgentId, room.principalId),
        description: room.description,
        name: room.name,
        room_id: room.id as RoomId,
        status: room.state,
        updated_at: requiredIso(room.createdAt),
      },
    };
  }

  async getNetwork(authUserId: string): Promise<NetworkProjection> {
    const principal = await this.requirePrincipal(authUserId);
    const database = this.database();
    const now = Date.now();

    const [agentRows, instanceRows] = await Promise.all([
      database
        .select()
        .from(agents)
        .where(eq(agents.principalId, principal.id))
        .orderBy(asc(agents.createdAt)),
      database
        .select()
        .from(instances)
        .where(eq(instances.principalId, principal.id))
        .orderBy(desc(instances.startedAt)),
    ]);

    const projectedInstances: InstanceProjection[] = instanceRows.map((instance) => ({
      agent_id: instance.agentId as AgentId,
      ended_at: iso(instance.endedAt),
      expires_at: requiredIso(instance.tokenExpiresAt),
      instance_id: instance.id as InstanceId,
      last_seen_at: requiredIso(instance.lastSeenAt),
      ...presenceOf(instance, now),
      principal_id: instance.principalId as PrincipalId,
      runtime_type: instance.runtimeKind,
      runtime_metadata: {
        cli_version: instance.cliVersion,
        ...(instance.runtimeMetadata ?? {}),
      },
      started_at: requiredIso(instance.startedAt),
      status: instance.state === "active" ? "online" : "ended",
      workspace_label: instance.cliVersion || null,
    }));

    /**
     * One dot per Instance. A dashed edge joins two Instances for every Room
     * they are both active in; weight is how many Rooms they share.
     *
     * Directed delegation and verification edges are not emitted: nothing in
     * the schema records either yet. See the TODO in the V1 design spec.
     */
    const roomRows = await database
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.principalId, principal.id));

    const edges: NetworkEdge[] = [];
    if (roomRows.length > 0) {
      const memberRows = await database
        .select()
        .from(roomMembers)
        .where(inArray(roomMembers.roomId, roomRows.map((room) => room.id)));

      const byRoom = new Map<string, string[]>();
      for (const member of memberRows) {
        if (member.state !== "active") continue;
        byRoom.set(member.roomId, [
          ...(byRoom.get(member.roomId) ?? []),
          member.instanceId,
        ]);
      }
      const weights = new Map<string, NetworkEdge>();
      for (const instanceIds of byRoom.values()) {
        const unique = [...new Set(instanceIds)].sort();
        for (let i = 0; i < unique.length; i += 1) {
          for (let j = i + 1; j < unique.length; j += 1) {
            const key = `${unique[i]}|${unique[j]}`;
            const existing = weights.get(key);
            if (existing) {
              existing.weight += 1;
              continue;
            }
            weights.set(key, {
              kind: "room_co_membership",
              source_id: unique[i] as InstanceId,
              target_id: unique[j] as InstanceId,
              weight: 1,
            });
          }
        }
      }
      edges.push(...weights.values());
    }

    return {
      agents: agentRows.map((agent) => agentProjection(agent)),
      connected_principals: [],
      edges,
      instances: projectedInstances,
      principal: principalProjection(principal),
    };
  }

  async listDecisions(authUserId: string): Promise<DecisionListResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const rows = await this.database()
      .select()
      .from(decisions)
      .where(eq(decisions.principalId, principal.id))
      .orderBy(desc(decisions.createdAt));

    return {
      decisions: rows.map((row) => this.decisionProjection(row)),
    };
  }

  async resolveDecision(
    authUserId: string,
    decisionId: DecisionId,
    resolution: DecisionResolution,
  ): Promise<DecisionProjection> {
    const principal = await this.requirePrincipal(authUserId);
    const database = this.database();

    const [existing] = await database
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.id, decisionId as never),
          eq(decisions.principalId, principal.id),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new SharedNetApiError("decision_not_found", 404, "Decision not found");
    }
    if (existing.status !== "pending") {
      throw new SharedNetApiError(
        "decision_already_resolved",
        409,
        "Decision was already resolved",
      );
    }
    if (
      (existing.mode === "text") !==
      (resolution.outcome === "answered")
    ) {
      throw new SharedNetApiError(
        "decision_resolution_invalid",
        422,
        "Resolution does not match the Decision mode",
      );
    }

    const [updated] = await database
      .update(decisions)
      .set({
        status: resolution.outcome,
        answer: resolution.outcome === "answered" ? resolution.responseText ?? "" : null,
        resolvedAt: new Date(),
      })
      .where(eq(decisions.id, decisionId as never))
      .returning();

    return this.decisionProjection(updated);
  }

  private decisionProjection(
    row: typeof decisions.$inferSelect,
  ): DecisionProjection {
    return {
      consequence: null,
      created_at: requiredIso(row.createdAt),
      decision_id: row.id as DecisionId,
      description: row.description,
      requester: {
        agent_id: row.requestedByAgentId as AgentId,
        instance_id: row.requestedByInstanceId as InstanceId,
        principal_id: row.principalId as PrincipalId,
      },
      resolved_at: iso(row.resolvedAt),
      response_mode: row.mode,
      response_text: row.answer,
      room_id: (row.roomId ?? null) as RoomId | null,
      status: row.status,
      target_principal_id: row.principalId as PrincipalId,
      title: row.title,
    };
  }
}

let runtimeClient: SharedNetServerClient | undefined;

export function getSharedNetServerClient(): SharedNetServerClient {
  runtimeClient ??= new SharedNetServerClient();
  return runtimeClient;
}
