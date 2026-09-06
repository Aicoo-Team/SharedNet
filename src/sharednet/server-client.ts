import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "@/packages/db/src/client.ts";
import { PostgresSharedNetRepository } from "@/packages/server/src/postgres-repository.ts";
import { RepositoryError } from "@/packages/server/src/repository.ts";
import {
  type CliLogin,
  normalizeCliLoginCode,
  digestSecret,
  generatePublicId,
  generateSecret,
  presenceFor,
} from "@/packages/protocol/src/index.ts";
import {
  agents,
  decisions,
  instances,
  messages,
  principals,
  roomInvites,
  roomMembers,
  rooms,
} from "@/packages/db/src/schema.ts";

import {
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

/**
 * Who opened the Room. A Room scheduled from the Web has no creator Instance:
 * the Principal itself is the actor, so the projection carries no instance_id.
 */
function roomCreator(
  tagOf: TagLookup,
  principalId: string,
  creatorInstanceId: string | null,
): ActorProjection {
  return creatorInstanceId === null
    ? actor(null, principalId)
    : actor(tagOf(creatorInstanceId), principalId, creatorInstanceId);
}

const ROOM_NAME_MAX = 120;
const ROOM_DESCRIPTION_MAX = 2000;

export type CreateRoomInput = { name: string; description?: string | null };

/** The driver behind an Instance, for a member card or a Network node. */
function runtimeSummary(
  instance: Pick<typeof instances.$inferSelect, "runtimeKind" | "cliVersion" | "runtimeMetadata"> | undefined,
): RuntimeSummary {
  if (!instance) return { kind: "custom", version: null, entrypoint: null, source: null };
  const metadata = instance.runtimeMetadata ?? {};
  const source = metadata.runtime_source;
  return {
    kind: instance.runtimeKind,
    version: metadata.driver_version ?? (instance.cliVersion === "invite" ? null : instance.cliVersion),
    entrypoint: metadata.entrypoint ?? null,
    source: source === "detected" || source === "declared" ? source : null,
  };
}

function inviteProjection(row: typeof roomInvites.$inferSelect): RoomInviteProjection {
  return {
    created_at: requiredIso(row.createdAt),
    expires_at: iso(row.expiresAt),
    invite_id: row.id,
    revoked_at: iso(row.revokedAt),
    room_id: row.roomId as RoomId,
    uses: row.uses,
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

    // A Room is visible to a Principal that has a membership in it, whether or
    // not it created the Room, and to the Principal that scheduled it from the
    // Web: an empty Room has no members yet, but its owner must see it to invite.
    const visibleRoomIds = await this.visibleRoomIds(principal.id);
    if (visibleRoomIds.length === 0) return { rooms: [] };

    const [roomRows, memberRows, tagOf] = await Promise.all([
      database
        .select()
        .from(rooms)
        .where(inArray(rooms.id, visibleRoomIds))
        .orderBy(desc(rooms.createdAt)),
      database
        .select()
        .from(roomMembers)
        .where(inArray(roomMembers.roomId, visibleRoomIds)),
      this.tagsFor(principal.id),
    ]);

    // Belt and braces over the SQL filter: never project a Room outside the set.
    const visible = new Set<string>(visibleRoomIds);
    const summaries: RoomSummary[] = roomRows.filter((room) => visible.has(room.id)).map((room) => {
      const members = memberRows.filter((member) => member.roomId === room.id);
      const latestSequence = room.nextSequence - 1;
      const creatorTag = tagOf(room.creatorInstanceId ?? null);
      return {
        description: room.description,
        latest_cursor: cursor(latestSequence),
        latest_sequence: latestSequence,
        member_count: members.filter((member) => member.state === "active").length,
        name: room.name,
        owner_agent_ids: creatorTag ? [creatorTag] : [],
        room_id: room.id as RoomId,
        status: room.state,
        updated_at: requiredIso(room.createdAt),
      };
    });

    return { rooms: summaries };
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

    const [room] = await this.database()
      .insert(rooms)
      .values({
        id: generatePublicId("rom"),
        // The dashboard's ids and the V1 schema's ids are the same strings under
        // different brands; the file's convention is to cross that seam with `never`.
        principalId: principal.id as never,
        name,
        description,
        state: "open",
        creatorInstanceId: null,
        nextSequence: 1,
        createdAt: new Date(),
        closedAt: null,
      })
      .returning();
    if (!room) {
      throw new SharedNetApiError("room_create_failed", 500, "Room creation failed");
    }

    return {
      description: room.description,
      latest_cursor: cursor(0),
      latest_sequence: 0,
      member_count: 0,
      name: room.name,
      owner_agent_ids: [],
      room_id: room.id as RoomId,
      status: room.state,
      updated_at: requiredIso(room.createdAt),
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
    const [room] = await this.database()
      .select()
      .from(rooms)
      .where(eq(rooms.id, roomId as never))
      .limit(1);
    // Only the Principal that owns the Room may open a door into it. A Room the
    // account does not own is reported as absent, as everywhere else.
    if (!room || room.principalId !== principal.id) {
      throw new SharedNetApiError("room_not_found", 404, "Room not found");
    }
    if (room.state === "closed") {
      throw new SharedNetApiError("room_closed", 409, "Room is closed");
    }
    const seconds = input.expires_in_seconds ?? 0;
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
      throw new SharedNetApiError("invalid_invite_expiry", 400, "Invite expiry must be a non-negative number of seconds");
    }
    const token = generateSecret("rit");
    const createdAt = new Date();
    const [invite] = await this.database()
      .insert(roomInvites)
      .values({
        id: generatePublicId("inv"),
        roomId: room.id,
        principalId: principal.id as never,
        tokenDigest: digestSecret(token),
        expiresAt: seconds > 0 ? new Date(createdAt.getTime() + seconds * 1000) : null,
        revokedAt: null,
        uses: 0,
        createdAt,
      })
      .returning();
    if (!invite) {
      throw new SharedNetApiError("invite_create_failed", 500, "Invite creation failed");
    }
    return { invite: inviteProjection(invite), token };
  }

  async revokeRoomInvite(
    authUserId: string,
    roomId: RoomId,
    inviteId: string,
  ): Promise<{ invite: RoomInviteProjection }> {
    const principal = await this.requirePrincipal(authUserId);
    const [invite] = await this.database()
      .update(roomInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(roomInvites.id, inviteId as never),
          eq(roomInvites.roomId, roomId as never),
          eq(roomInvites.principalId, principal.id as never),
        ),
      )
      .returning();
    if (!invite) {
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
    const database = this.database();
    const [room] = await database
      .select()
      .from(rooms)
      .where(eq(rooms.id, roomId as never))
      .limit(1);
    if (!room || room.principalId !== principal.id) {
      throw new SharedNetApiError("room_not_found", 404, "Room not found");
    }
    let closed = room;
    if (room.state !== "closed") {
      const [updated] = await database
        .update(rooms)
        .set({ state: "closed", closedAt: new Date() })
        .where(eq(rooms.id, room.id))
        .returning();
      if (!updated) {
        throw new SharedNetApiError("room_close_failed", 500, "Room close failed");
      }
      closed = updated;
    }
    const tagOf = await this.tagsFor(principal.id);
    return {
      room: {
        access_policy: "anyone_with_id",
        created_at: requiredIso(closed.createdAt),
        creator: roomCreator(tagOf, closed.principalId, closed.creatorInstanceId),
        description: closed.description,
        name: closed.name,
        room_id: closed.id as RoomId,
        status: closed.state,
        updated_at: requiredIso(closed.closedAt ?? closed.createdAt),
      },
    };
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
    const database = this.database();
    const [room] = await database
      .select()
      .from(rooms)
      .where(eq(rooms.id, roomId as never))
      .limit(1);
    if (!room || room.principalId !== principal.id) {
      throw new SharedNetApiError("room_not_found", 404, "Room not found");
    }
    const now = new Date();
    const notFound = () => new SharedNetApiError("member_not_found", 404, "Member not found");

    const [member] = await database
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.instanceId, memberId as never)))
      .limit(1);
    if (!member) throw notFound();
    let left = member;
    if (member.state === "active") {
      const [updated] = await database
        .update(roomMembers)
        .set({ state: "left", leftAt: now })
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.instanceId, member.instanceId)))
        .returning();
      if (!updated) throw notFound();
      left = updated;
    }
    const [tagOf, instanceSeen, principalRows] = await Promise.all([
      this.tagsFor(principal.id),
      this.instanceRows(),
      database
        .select({ id: principals.id, authUserId: principals.authUserId })
        .from(principals)
        .where(eq(principals.id, left.principalId as never)),
    ]);
    const seen = instanceSeen.get(left.instanceId);
    const leftPrincipal = principalRows.find((row) => (row.id as string) === (left.principalId as string));
    return {
      membership: {
        agent_id: tagOf(left.instanceId),
        instance_id: left.instanceId as InstanceId,
        joined_at: requiredIso(left.joinedAt),
        kind: leftPrincipal && leftPrincipal.authUserId === null ? "guest" : "instance",
        last_read_sequence: 0,
        left_at: iso(left.leftAt),
        member_id: left.instanceId,
        name: seen?.displayName ?? null,
        presence: seen ? presenceOf(seen, now.getTime()).presence : "offline",
        principal_id: left.principalId as PrincipalId,
        room_id: left.roomId as RoomId,
        runtime: runtimeSummary(seen),
        status: left.state,
      },
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

  async getRoom(authUserId: string, roomId: RoomId): Promise<RoomDetail> {
    const principal = await this.requirePrincipal(authUserId);
    const database = this.database();

    const [room] = await database
      .select()
      .from(rooms)
      .where(eq(rooms.id, roomId as never))
      .limit(1);

    if (!room) {
      throw new SharedNetApiError("room_not_found", 404, "Room not found");
    }

    const [memberRows, messageRows, tagOf, instanceSeen] = await Promise.all([
      database.select().from(roomMembers).where(eq(roomMembers.roomId, room.id)),
      database
        .select()
        .from(messages)
        .where(eq(messages.roomId, room.id))
        .orderBy(asc(messages.sequence)),
      this.tagsFor(principal.id),
      this.instanceRows(),
    ]);
    const now = new Date();
    const instancePresence = (instanceId: string): RoomMembership["presence"] => {
      const row = instanceSeen.get(instanceId);
      return row ? presenceOf(row, now.getTime()).presence : "offline";
    };
    // Every member is an Instance. One of an anonymous Principal (no account
    // behind it, not yet bound) is shown by the name it gave. Kind follows the
    // Principal, so a bound seat reads as an Instance of the account.
    const principalIds = [...new Set(memberRows.map((member) => member.principalId as string))];
    const anonymousPrincipals = new Set(
      principalIds.length === 0
        ? []
        : (
            await database
              .select({ id: principals.id, authUserId: principals.authUserId })
              .from(principals)
              .where(inArray(principals.id, principalIds as never))
          )
            .filter((row) => row.authUserId === null)
            .map((row) => row.id as string),
    );
    const anonymous = (instanceId: string): boolean => {
      const principalId = instanceSeen.get(instanceId)?.principalId;
      return principalId !== undefined && anonymousPrincipals.has(principalId as string);
    };
    const nameOf = (instanceId: string): string | null =>
      instanceSeen.get(instanceId)?.displayName ?? null;
    const runtimeOf = (instanceId: string): RuntimeSummary =>
      runtimeSummary(instanceSeen.get(instanceId));


    // Membership admits the viewer, and so does having scheduled the Room from
    // the Web. A Room the account can neither see nor own is reported as absent
    // rather than as forbidden.
    const isOwner = room.principalId === principal.id;
    if (!isOwner && !memberRows.some((member) => member.principalId === principal.id)) {
      throw new SharedNetApiError("room_not_found", 404, "Room not found");
    }

    const memberships: RoomMembership[] = memberRows.map(
      (member): RoomMembership => ({
        agent_id: tagOf(member.instanceId),
        instance_id: member.instanceId as InstanceId,
        joined_at: requiredIso(member.joinedAt),
        kind: anonymous(member.instanceId) ? "guest" : "instance",
        last_read_sequence: 0,
        left_at: iso(member.leftAt),
        member_id: member.instanceId,
        name: nameOf(member.instanceId),
        presence: instancePresence(member.instanceId),
        principal_id: member.principalId as PrincipalId,
        room_id: member.roomId as RoomId,
        runtime: runtimeOf(member.instanceId),
        status: member.state,
      }),
    );

    const projectedMessages: RoomMessage[] = messageRows.map((message) => ({
      attachment_ids: [],
      content: message.content,
      created_at: requiredIso(message.createdAt),
      message_id: message.id as RoomMessage["message_id"],
      reply_to: (message.replyToMessageId ?? null) as RoomMessage["reply_to"],
      resolution_state: "not_required",
      room_id: message.roomId as RoomId,
      // An anonymous Principal's Instance is shown by the name it gave.
      sender:
        message.senderInstanceId && anonymous(message.senderInstanceId)
          ? {
              agent_id: null,
              name: nameOf(message.senderInstanceId) ?? "anonymous",
              principal_id: message.senderPrincipalId as PrincipalId,
            }
          : actor(
              tagOf(message.senderInstanceId),
              message.senderPrincipalId,
              message.senderInstanceId ?? undefined,
            ),
      sequence: message.sequence,
      tags: [],
    }));

    return {
      memberships,
      messages: projectedMessages,
      next_cursor: cursor(room.nextSequence - 1),
      room: {
        access_policy: "anyone_with_id",
        created_at: requiredIso(room.createdAt),
        creator: roomCreator(tagOf, room.principalId, room.creatorInstanceId),
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
      agent_id: (instance.agentId ?? null) as AgentId | null,
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
    const visibleRoomIds = await this.memberRoomIds(principal.id);

    const edges: NetworkEdge[] = [];
    if (visibleRoomIds.length > 0) {
      const memberRows = await database
        .select()
        .from(roomMembers)
        .where(inArray(roomMembers.roomId, visibleRoomIds));

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

    const tagOf = await this.tagsFor(principal.id);
    return {
      decisions: rows.map((row) => this.decisionProjection(row, tagOf)),
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

    return this.decisionProjection(updated, await this.tagsFor(principal.id));
  }

  /** Rooms this Principal has a membership in — the Rooms it can see. */
  private async memberRoomIds(
    principalId: string,
  ): Promise<Array<(typeof roomMembers.$inferSelect)["roomId"]>> {
    const rows = await this.database()
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(eq(roomMembers.principalId, principalId as never));
    return [...new Set(rows.map((row) => row.roomId))];
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

  private decisionProjection(
    row: typeof decisions.$inferSelect,
    tagOf: TagLookup,
  ): DecisionProjection {
    return {
      consequence: null,
      created_at: requiredIso(row.createdAt),
      decision_id: row.id as DecisionId,
      description: row.description,
      requester: {
        agent_id: tagOf(row.requestedByInstanceId),
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
