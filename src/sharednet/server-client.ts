import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "@/packages/db/src/client.ts";
import { PostgresSharedNetRepository } from "@/packages/server/src/postgres-repository.ts";
import { RepositoryError, type SharedNetRepository } from "@/packages/server/src/repository.ts";
import {
  type CliLogin,
  type Message,
  type Principal,
  type Room,
  type RoomInvite,
  type RoomMember,
  normalizeCliLoginCode,
} from "@/packages/protocol/src/index.ts";
import {
  agents,
  decisions,
  instances,
  principals,
  roomMembers,
  rooms,
} from "@/packages/db/src/schema.ts";

import {
  type CliClaimProjection,
  type CliLoginProjection,
  type RuntimeSummary,
  type CloseRoomResponse,
  type RemoveRoomMemberResponse,
  type ActorProjection,
  type AgentId,
  type CreateRoomInviteResponse,
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
  type RoomInviteProjection,
  type RoomListResponse,
  type RoomMembership,
  type RoomMessage,
  type RoomProjection,
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

/**
 * A Principal seen from another: an account, or an anonymous Principal that
 * an invite join provisioned and nobody has bound yet. The label is the name
 * its seat gave; the summary says who invited it.
 */
function connectedPrincipalProjection(
  row: typeof principals.$inferSelect,
  viewerPrincipalId: string,
): PrincipalProjection {
  const anonymous = row.authUserId === null;
  if (!anonymous) return principalProjection(row);
  const invitedBy =
    (row.invitedByPrincipalId as string | null) === viewerPrincipalId
      ? "invited by you"
      : row.invitedByPrincipalId
        ? `invited by ${row.invitedByPrincipalId}`
        : "invited";
  return {
    created_at: requiredIso(row.createdAt),
    diagnostic_label: row.displayName ?? "anonymous",
    kind: "anonymous",
    principal_id: row.id as PrincipalId,
    summary: `Anonymous Principal · ${invitedBy} · bind it with sharednet login`,
  };
}

/** An Agent is a named tag over Instances; the projection is its name and id. */
function agentProjection(row: {
  id: string;
  principalId: string;
  handle: string;
  displayName: string | null;
  description: string | null;
  createdAt: Date | string;
}): AgentProjection {
  return {
    agent_id: row.id as AgentId,
    created_at: requiredIso(row.createdAt),
    diagnostic_label: row.displayName ?? `@${row.handle}`,
    discoverability: false,
    handle: row.handle,
    principal_id: row.principalId as PrincipalId,
    summary: row.description ?? `Tag @${row.handle}`,
  };
}

/**
 * The tag an Instance is currently under. Nothing stores a copy of it beside
 * a message or membership, so every projection resolves it through the
 * Instance at read time and regrouping shows up everywhere at once.
 */
type TagLookup = (instanceId: string | null) => AgentId | null;

function tagLookup(rows: Array<{ id: string; agentId: string | null }>): TagLookup {
  const byInstance = new Map(rows.map((row) => [row.id, row.agentId]));
  return (instanceId) =>
    (instanceId === null ? null : (byInstance.get(instanceId) ?? null)) as AgentId | null;
}

const ROOM_NAME_MAX = 120;
const ROOM_DESCRIPTION_MAX = 2000;

export type CreateRoomInput = { name: string; description?: string | null };

/** The driver behind a seat, for a member card. */
function runtimeSummary(member: Pick<RoomMember, "runtime_kind" | "runtime_version" | "runtime_metadata">): RuntimeSummary {
  const metadata = member.runtime_metadata ?? {};
  const source = metadata.runtime_source;
  return {
    kind: member.runtime_kind,
    version: metadata.driver_version ?? (member.runtime_version === "invite" || member.runtime_version === "" ? null : member.runtime_version),
    entrypoint: metadata.entrypoint ?? null,
    source: source === "detected" || source === "declared" ? source : null,
  };
}

function inviteProjection(invite: RoomInvite): RoomInviteProjection {
  return {
    created_at: invite.created_at,
    expires_at: invite.expires_at,
    invite_id: invite.id,
    revoked_at: invite.revoked_at,
    room_id: invite.room_id as RoomId,
    uses: invite.uses,
  };
}

/**
 * Who opened the Room. A Room scheduled from the Web has no creator Instance:
 * the Principal itself is the actor, so the projection carries no instance_id.
 */
function roomProjection(room: Room, updatedAt: string): RoomProjection {
  return {
    access_policy: "anyone_with_id",
    created_at: room.created_at,
    creator:
      room.creator_instance_id === null
        ? actor(null, room.principal_id)
        : actor(room.creator_agent_id as AgentId | null, room.principal_id, room.creator_instance_id),
    description: room.description,
    name: room.name,
    room_id: room.id as RoomId,
    status: room.state,
    updated_at: updatedAt,
  };
}

/** A seat as the Room page shows it: the domain's member, plus the driver summary. */
function membershipProjection(member: RoomMember): RoomMembership {
  return {
    agent_id: member.agent_id as AgentId | null,
    instance_id: member.instance_id as InstanceId,
    joined_at: member.joined_at,
    kind: member.kind,
    last_read_sequence: 0,
    admitted_by: member.admitted_by,
    added_by_instance_id: member.added_by_instance_id as InstanceId | null,
    left_at: member.left_at,
    member_id: member.instance_id,
    name: member.name,
    presence: member.presence,
    principal_id: member.principal_id as PrincipalId,
    room_id: member.room_id as RoomId,
    runtime: runtimeSummary(member),
    status: member.state,
  };
}

/** An anonymous Principal's Instance is shown by the name it gave. */
function messageProjection(message: Message): RoomMessage {
  return {
    attachment_ids: [],
    content: message.content,
    created_at: message.created_at,
    message_id: message.id as RoomMessage["message_id"],
    reply_to: message.reply_to_message_id as RoomMessage["reply_to"],
    resolution_state: "not_required",
    room_id: message.room_id as RoomId,
    sender:
      message.sender.kind === "guest"
        ? {
            agent_id: null,
            instance_id: message.sender_instance_id as InstanceId,
            name: message.sender.name ?? "anonymous",
            principal_id: message.sender_principal_id as PrincipalId,
          }
        : actor(message.sender_agent_id as AgentId | null, message.sender_principal_id, message.sender_instance_id),
    sequence: message.sequence,
    tags: [],
  };
}

function actor(
  agentId: AgentId | null,
  principalId: string,
  instanceId?: string,
): ActorProjection {
  const projection: ActorProjection = {
    agent_id: agentId,
    principal_id: principalId as PrincipalId,
  };
  if (instanceId !== undefined) {
    projection.instance_id = instanceId as InstanceId;
  }
  return projection;
}

/** A human tells untagged sessions apart by where they run. */
function workspaceLabel(metadata: Record<string, string> | null | undefined): string | null {
  const workspace = metadata?.workspace?.trim();
  if (!workspace) return null;
  const segments = workspace.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? workspace;
}

export class SharedNetServerClient {
  private readonly injected: SharedNetRepository | undefined;

  /**
   * The Dashboard is one more door onto the domain: every Room operation goes
   * through the same repository the V1 API uses, scoped to the account's
   * Principal. Tests hand in a memory repository; production reads Postgres.
   */
  constructor(repository?: SharedNetRepository) {
    this.injected = repository;
  }

  private database() {
    return getDatabase();
  }

  private repository(): SharedNetRepository {
    return this.injected ?? new PostgresSharedNetRepository(this.database());
  }

  /** Resolve the Principal this Better Auth user owns, or fail closed. */
  private async requirePrincipal(authUserId: string): Promise<Principal> {
    const principal = await this.repository().principalForAccount(authUserId);
    if (!principal) {
      throw new SharedNetApiError("principal_not_found", 404, "No Principal for this account");
    }
    return principal;
  }

  /** Run a repository call, and speak its refusal in the Dashboard's error shape. */
  private async domain<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new SharedNetApiError(error.code, error.status, error.message);
      }
      throw error;
    }
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

  /** The Rooms this account scheduled or holds an active seat in, newest first. */
  async listRooms(authUserId: string): Promise<RoomListResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { items } = await this.domain(() => this.repository().listRoomsForPrincipal(principal.id));
    return {
      rooms: items.map(
        ({ room, active_member_count, latest_sequence }): RoomSummary => ({
          description: room.description,
          latest_cursor: cursor(latest_sequence),
          latest_sequence,
          member_count: active_member_count,
          name: room.name,
          owner_agent_ids: room.creator_agent_id ? [room.creator_agent_id as AgentId] : [],
          room_id: room.id as RoomId,
          status: room.state,
          updated_at: room.created_at,
        }),
      ),
    };
  }

  /**
   * Schedule an empty Room from the Web. Like booking a meeting: the Principal
   * owns the container and hands its id to Agents, who join and act. No
   * Instance is involved, so the Room has no creator Instance and no members.
   */
  async createRoom(authUserId: string, input: CreateRoomInput): Promise<RoomSummary> {
    const principal = await this.requirePrincipal(authUserId);
    const name = input.name.normalize("NFKC").trim();
    const description = input.description?.normalize("NFKC").trim() || null;
    if (name.length < 1 || name.length > ROOM_NAME_MAX) {
      throw new SharedNetApiError("invalid_room_name", 400, "Room name must be 1–120 characters");
    }
    if (description !== null && description.length > ROOM_DESCRIPTION_MAX) {
      throw new SharedNetApiError(
        "invalid_room_description",
        400,
        "Room description must be at most 2000 characters",
      );
    }
    const { room } = await this.domain(() => this.repository().scheduleRoom(principal.id, { name, description }));
    return {
      description: room.description,
      latest_cursor: cursor(0),
      latest_sequence: 0,
      member_count: 0,
      name: room.name,
      owner_agent_ids: [],
      room_id: room.id as RoomId,
      status: room.state,
      updated_at: room.created_at,
    };
  }

  /**
   * Mints a Room invite token. The raw token is returned once; only its digest
   * is stored. No expiry unless asked for: a Room is a standing channel and its
   * invite a standing door, closed by revocation rather than by a clock.
   */
  async createRoomInvite(
    authUserId: string,
    roomId: RoomId,
    input: { expires_in_seconds?: number | null } = {},
  ): Promise<CreateRoomInviteResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const seconds = input.expires_in_seconds ?? 0;
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
      throw new SharedNetApiError("invalid_invite_expiry", 400, "Invite expiry must be a non-negative number of seconds");
    }
    const { invite, token } = await this.domain(() =>
      this.repository().createRoomInvite({ roomId: roomId as never, principalId: principal.id, expiresInSeconds: seconds }),
    );
    return { invite: inviteProjection(invite), token };
  }

  async revokeRoomInvite(
    authUserId: string,
    roomId: RoomId,
    inviteId: string,
  ): Promise<{ invite: RoomInviteProjection }> {
    const principal = await this.requirePrincipal(authUserId);
    const { invite } = await this.domain(() =>
      this.repository().revokeRoomInvite({ inviteId: inviteId as never, principalId: principal.id }),
    );
    // An invite is addressed by its Room on the Web; one that opens another
    // Room is reported as absent, the way the Room itself would be.
    if ((invite.room_id as string) !== (roomId as string)) {
      throw new SharedNetApiError("room_not_found", 404, "Room not found");
    }
    return { invite: inviteProjection(invite) };
  }

  /**
   * Close a Room this account owns. An explicit human action and the only way
   * a Room ends: members' tokens stop working at once, history stays readable
   * from the Web. Closing a closed Room is a no-op that returns it as it is.
   */
  async closeRoom(authUserId: string, roomId: RoomId): Promise<CloseRoomResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { room } = await this.domain(() => this.repository().closeRoom(principal.id, roomId as never));
    return { room: roomProjection(room, room.closed_at ?? room.created_at) };
  }

  /**
   * Remove one member from a Room this account owns, by its Instance id. Its
   * token stops working for this Room; what it said stays. Removing a member
   * that already left returns it as it is.
   */
  async removeRoomMember(
    authUserId: string,
    roomId: RoomId,
    memberId: string,
  ): Promise<RemoveRoomMemberResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { membership } = await this.domain(() =>
      this.repository().removeRoomMember(principal.id, roomId as never, memberId as never),
    );
    return { membership: membershipProjection(membership) };
  }

  /** A Room this account owns or sits in, with every seat and the whole log. */
  async getRoom(authUserId: string, roomId: RoomId): Promise<RoomDetail> {
    const principal = await this.requirePrincipal(authUserId);
    const detail = await this.domain(() => this.repository().getRoomForPrincipal(principal.id, roomId as never));
    return {
      memberships: detail.memberships.map(membershipProjection),
      messages: detail.messages.map(messageProjection),
      next_cursor: cursor(detail.latest_sequence),
      room: roomProjection(detail.room, detail.room.created_at),
    };
  }

  /**
   * What the approve page shows for a code: the login's label, the seats it
   * would bind (named, with their Rooms), and its state. Nothing secret.
   */
  async getCliLogin(authUserId: string, code: string): Promise<CliLoginProjection> {
    await this.requirePrincipal(authUserId);
    const normalized = normalizeCliLoginCode(code);
    if (normalized === null) throw new SharedNetApiError("login_not_found", 404, "CLI login not found");
    const found = await this.loginRepository().getCliLoginByCode(normalized);
    if (!found) throw new SharedNetApiError("login_not_found", 404, "CLI login not found");
    return this.cliLoginProjection(found.login);
  }

  /** Approve a pending CLI login as this account, binding the seats it holds. */
  async approveCliLogin(authUserId: string, code: string): Promise<CliLoginProjection> {
    const principal = await this.requirePrincipal(authUserId);
    const normalized = normalizeCliLoginCode(code);
    if (normalized === null) throw new SharedNetApiError("login_not_found", 404, "CLI login not found");
    try {
      const { login } = await this.loginRepository().approveCliLogin({
        code: normalized,
        principalId: principal.id as never,
      });
      return this.cliLoginProjection(login);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new SharedNetApiError(error.code, error.status, error.message);
      }
      throw error;
    }
  }

  /** A claim code for this account, for the join page's Agent command. */
  async createCliClaim(authUserId: string, label: string | null): Promise<CliClaimProjection> {
    const principal = await this.requirePrincipal(authUserId);
    const { login, claim } = await this.loginRepository().createCliClaim({ principalId: principal.id as never, label });
    return { claim, login_id: login.id, expires_at: login.expires_at, principal_id: principal.id as PrincipalId };
  }

  private loginRepository(): PostgresSharedNetRepository {
    return new PostgresSharedNetRepository(this.database());
  }

  private async cliLoginProjection(login: CliLogin): Promise<CliLoginProjection> {
    const database = this.database();
    const seats: CliLoginProjection["seats"] = [];
    if (login.bind_instance_ids.length > 0) {
      const rows = await database
        .select({
          instanceId: instances.id,
          name: instances.displayName,
          runtimeKind: instances.runtimeKind,
          roomId: roomMembers.roomId,
          roomName: rooms.name,
        })
        .from(instances)
        .leftJoin(roomMembers, eq(roomMembers.instanceId, instances.id))
        .leftJoin(rooms, eq(rooms.id, roomMembers.roomId))
        .where(inArray(instances.id, login.bind_instance_ids as never));
      const byInstance = new Map<string, CliLoginProjection["seats"][number]>();
      for (const row of rows) {
        const seat = byInstance.get(row.instanceId) ?? {
          instance_id: row.instanceId as InstanceId,
          name: row.name ?? null,
          runtime_kind: row.runtimeKind,
          rooms: [],
        };
        if (row.roomId && row.roomName) seat.rooms.push({ room_id: row.roomId as RoomId, name: row.roomName });
        byInstance.set(row.instanceId, seat);
      }
      seats.push(...byInstance.values());
    }
    return {
      login_id: login.id,
      state: login.state,
      label: login.label,
      expires_at: login.expires_at,
      approved_at: login.approved_at,
      seats,
    };
  }

  async getNetwork(authUserId: string): Promise<NetworkProjection> {
    const principal = await this.requirePrincipal(authUserId);
    const database = this.database();
    const now = Date.now();

    // The Network is what this Principal can see: its own Agents and Instances,
    // and every Principal that shares a Room with it, drawn through the
    // Instances that sit in those Rooms. Nothing else is discoverable.
    const visibleRoomIds = await this.visibleRoomIds(principal.id);
    const memberRows =
      visibleRoomIds.length > 0
        ? await database.select().from(roomMembers).where(inArray(roomMembers.roomId, visibleRoomIds))
        : [];
    const activeMembers = memberRows.filter((member) => member.state === "active");
    const coMemberInstanceIds = new Set(activeMembers.map((member) => member.instanceId as string));
    const connectedPrincipalIds = [
      ...new Set(
        activeMembers
          .map((member) => member.principalId as string)
          .filter((id) => id !== (principal.id as string)),
      ),
    ];
    const visiblePrincipalIds = new Set([principal.id as string, ...connectedPrincipalIds]);

    const [agentRows, allInstanceRows, connectedRows] = await Promise.all([
      database.select().from(agents).orderBy(asc(agents.createdAt)),
      database.select().from(instances).orderBy(desc(instances.startedAt)),
      connectedPrincipalIds.length > 0
        ? database.select().from(principals).where(inArray(principals.id, connectedPrincipalIds as never))
        : Promise.resolve([] as (typeof principals.$inferSelect)[]),
    ]);
    const visibleAgents = agentRows.filter((agent) => visiblePrincipalIds.has(agent.principalId as string));
    const instanceRows = allInstanceRows.filter(
      (instance) =>
        (instance.principalId as string) === (principal.id as string) ||
        coMemberInstanceIds.has(instance.id as string),
    );

    const projectedInstances: InstanceProjection[] = instanceRows.map((instance) => ({
      agent_id: (instance.agentId ?? null) as AgentId | null,
      display_name: instance.displayName ?? null,
      ended_at: iso(instance.endedAt),
      expires_at: iso(instance.tokenExpiresAt),
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
      workspace_label: workspaceLabel(instance.runtimeMetadata),
    }));

    /**
     * One dot per Instance. A dashed edge joins two Instances for every Room
     * they are both active in; weight is how many Rooms they share.
     *
     * Directed delegation and verification edges are not emitted: nothing in
     * the schema records either yet. See the TODO in the V1 design spec.
     */
    const byRoom = new Map<string, string[]>();
    for (const member of activeMembers) {
      byRoom.set(member.roomId, [...(byRoom.get(member.roomId) ?? []), member.instanceId]);
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

    return {
      // Another account's tags are shown when its Instances share a Room with
      // the caller; that is the only discoverability there is.
      agents: visibleAgents.map((agent) => ({
        ...agentProjection(agent),
        discoverability: (agent.principalId as string) !== (principal.id as string),
      })),
      connected_principals: connectedRows
        .filter((row) => connectedPrincipalIds.includes(row.id as string))
        .map((row) => connectedPrincipalProjection(row, principal.id as string)),
      edges: [...weights.values()],
      instances: projectedInstances,
      principal: principalProjection({ id: principal.id, displayName: principal.display_name, createdAt: principal.created_at }),
    };
  }

  async listDecisions(authUserId: string): Promise<DecisionListResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const rows = await this.database()
      .select()
      .from(decisions)
      .where(eq(decisions.principalId, principal.id))
      .orderBy(desc(decisions.createdAt));

    const instanceRows = await this.instanceRows();
    return {
      decisions: rows.map((row) => this.decisionProjection(row, instanceRows)),
    };
  }

  async resolveDecision(
    authUserId: string,
    decisionId: DecisionId,
    resolution: DecisionResolution,
  ): Promise<DecisionProjection> {
    const principal = await this.requirePrincipal(authUserId);
    // One transaction: the Decision is locked, moved, and the seat it grants
    // written together, so "approved but never seated" cannot be left behind.
    return this.database().transaction(async (tx) => this.resolveDecisionIn(tx, principal.id, decisionId, resolution));
  }

  private async resolveDecisionIn(
    database: ReturnType<SharedNetServerClient["database"]>,
    principalId: string,
    decisionId: DecisionId,
    resolution: DecisionResolution,
  ): Promise<DecisionProjection> {
    const [existing] = await database
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.id, decisionId as never),
          eq(decisions.principalId, principalId as never),
        ),
      )
      .for("update")
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

    // The human said yes to a request to seat one of this Principal's private
    // Instances: the seat is written here, the same way the Instance's own
    // API answer writes it (decision 2026-09-06 reach, §4).
    if (resolution.outcome === "approved" && existing.requestedForInstanceId && existing.roomId) {
      await this.seatAccepted(database, existing.roomId, existing.requestedForInstanceId, existing.requestedByInstanceId);
    }

    const instanceRows = await database.select().from(instances);
    return this.decisionProjection(updated, new Map(instanceRows.map((row) => [row.id as string, row])));
  }

  /** Writes the accepted seat, reviving a left one; a live seat is left alone. */
  private async seatAccepted(
    database: ReturnType<SharedNetServerClient["database"]>,
    roomId: string,
    instanceId: string,
    addedBy: string,
  ): Promise<void> {
    const memberRows = await database.select().from(roomMembers);
    const existing = memberRows.find(
      (row) => (row.roomId as string) === roomId && (row.instanceId as string) === instanceId,
    );
    if (existing?.state === "active") return;
    const now = new Date();
    if (existing) {
      await database
        .update(roomMembers)
        .set({
          state: "active",
          leftAt: null,
          joinedAt: now,
          admittedBy: "accepted",
          inviteId: null,
          addedByInstanceId: addedBy as never,
        })
        .where(and(eq(roomMembers.roomId, roomId as never), eq(roomMembers.instanceId, instanceId as never)))
        .returning();
      return;
    }
    const instanceRows = await database.select().from(instances);
    const target = instanceRows.find((row) => (row.id as string) === instanceId);
    if (!target) throw new SharedNetApiError("instance_not_found", 404, "Instance not found");
    await database
      .insert(roomMembers)
      .values({
        principalId: target.principalId as never,
        roomId: roomId as never,
        instanceId: instanceId as never,
        state: "active",
        joinedAt: now,
        leftAt: null,
        admittedBy: "accepted",
        inviteId: null,
        addedByInstanceId: addedBy as never,
      })
      .returning();
  }

  /** Rooms this Principal has a membership in — the Rooms it can see. */
  private async memberRoomIds(
    principalId: string,
  ): Promise<Array<(typeof roomMembers.$inferSelect)["roomId"]>> {
    const rows = await this.database()
      .select({ roomId: roomMembers.roomId, state: roomMembers.state })
      .from(roomMembers)
      .where(and(eq(roomMembers.principalId, principalId as never), eq(roomMembers.state, "active")));
    // The filter is repeated here for the test stub, which ignores `where`.
    return [...new Set(rows.filter((row) => row.state === "active").map((row) => row.roomId))];
  }

  /** Rooms this Principal is a member of, plus the ones it scheduled itself. */
  private async visibleRoomIds(
    principalId: string,
  ): Promise<Array<(typeof rooms.$inferSelect)["id"]>> {
    const [memberIds, ownedRows] = await Promise.all([
      this.memberRoomIds(principalId),
      this.database()
        .select({ id: rooms.id, principalId: rooms.principalId })
        .from(rooms)
        .where(eq(rooms.principalId, principalId as never)),
    ]);
    const ownedIds = ownedRows
      .filter((row) => row.principalId === principalId)
      .map((row) => row.id);
    return [...new Set([...memberIds, ...ownedIds])];
  }

  /** Every Instance row by id, for lease-derived member presence. */
  private async instanceRows(): Promise<Map<string, typeof instances.$inferSelect>> {
    const rows = await this.database().select().from(instances);
    return new Map(rows.map((row) => [row.id as string, row]));
  }

  /** Current tag per Instance of one Principal, resolved once per request. */
  private async tagsFor(principalId: string): Promise<TagLookup> {
    const rows = await this.database()
      .select({ id: instances.id, agentId: instances.agentId })
      .from(instances)
      .where(eq(instances.principalId, principalId as never));
    return tagLookup(rows);
  }

  /**
   * The requester may be another Principal's Instance since the reach
   * decision, so who asked is read off the Instance row, not the Decision's
   * own Principal, which is the one deciding.
   */
  private decisionProjection(
    row: typeof decisions.$inferSelect,
    instanceRows: Map<string, typeof instances.$inferSelect>,
  ): DecisionProjection {
    const asker = instanceRows.get(row.requestedByInstanceId as string);
    return {
      consequence: null,
      created_at: requiredIso(row.createdAt),
      decision_id: row.id as DecisionId,
      description: row.description,
      requester: {
        agent_id: (asker?.agentId ?? null) as AgentId | null,
        instance_id: row.requestedByInstanceId as InstanceId,
        principal_id: (asker?.principalId ?? row.principalId) as PrincipalId,
      },
      resolved_at: iso(row.resolvedAt),
      response_mode: row.mode,
      response_text: row.answer,
      room_id: (row.roomId ?? null) as RoomId | null,
      requested_for_instance_id: (row.requestedForInstanceId ?? null) as InstanceId | null,
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
