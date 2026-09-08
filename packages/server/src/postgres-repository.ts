import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";

import { defaultKeyHasher } from "@better-auth/api-key";
import { and, asc, count, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";

import {
  cliLogins,
  agents,
  apiKey,
  decisions,
  idempotencyRecords,
  instances,
  messages,
  principals,
  roomInvites,
  roomMembers,
  rooms,
  type SharedNetDatabase,
} from "../../db/src/index.ts";
import {
  type ClpSecret,
  type CliLoginId,
  type CliLogin,
  generateCliLoginCode,
  type MemberKind,
  type SniSecret,
  type JoinRoomRequest,
  encodeInboxCursor,
  type InboxPosition,
  digestSecret,
  generatePublicId,
  generateSecret,
  presenceFor,
  type Agent,
  type AgentId,
  type ApiKeyId,
  type CreateAgentRequest,
  type Instance,
  type InstanceId,
  type InviteId,
  type JoinRoomWithInviteRequest,
  type Message,
  type MessageId,
  type Page,
  type Principal,
  type PrincipalId,
  type RitSecret,
  type Room,
  type RoomId,
  type RoomInvite,
  type RoomMember,
  type StartInstanceRequest,
} from "../../protocol/src/index.ts";
import {
  IDEMPOTENCY_RETENTION_MS,
  MAX_AGENTS_PER_PRINCIPAL,
  PRESENCE_LEASE_MS,
  RepositoryError,
  type IdempotencyResult,
  type IdempotencyScope,
  type InstanceAuth,
  type PrincipalAuth,
  type RoomAuth,
  type SharedNetRepository,
  type StoredHttpResult,
} from "./repository.ts";
import { sharedRoomsEdges, type DecisionAnswer, type DecisionOverview, type NetworkView, type RoomOverview, type SeatOverview } from "./repository.ts";
import type {
  AddRoomMembersRequest,
  Admission,
  InviteDescription,
  CreateRoomRequest,
  Decision,
  DecisionId,
  DecisionStatus,
  ResolveDecisionRequest,
  UpdateInstanceRequest,
} from "../../protocol/src/index.ts";

type Transaction = Parameters<Parameters<SharedNetDatabase["transaction"]>[0]>[0];
type InstanceRow = typeof instances.$inferSelect;
type RoomRow = typeof rooms.$inferSelect;
type InviteRow = typeof roomInvites.$inferSelect;
type PrincipalRow = typeof principals.$inferSelect;
/**
 * What a message or membership needs to know about its Instance to name it,
 * and whether the Principal behind it has an account. Kind follows the
 * Principal: a seat joined by invite reads as `instance` once it is bound.
 */
type SenderInfo = (Pick<InstanceRow, "displayName"> & { principalAuthUserId: string | null }) | null;

/**
 * An invite-admitted Instance counts as seen at most this often, so `wait`
 * polls do not write on every tick. Any authenticated request is its presence.
 */
/** Any authenticated request is presence; the row is touched at most this often. */
const SEEN_REFRESH_MS = 10_000;
/** A claim sits on a page the human is looking at; unused, it lapses after a week. */
const CLI_CLAIM_TTL_MS = 7 * 24 * 60 * 60_000;

export type PostgresRepositoryOptions = {
  now?: () => Date;
};

function timestamp(value: Date): string {
  return value.toISOString();
}

function projectPrincipal(row: typeof principals.$inferSelect): Principal {
  return {
    id: row.id,
    display_name: row.displayName,
    default_reach: row.defaultReach,
    created_at: timestamp(row.createdAt),
    invited_by_principal_id: row.invitedByPrincipalId ?? null,
  };
}

function projectAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    principal_id: row.principalId,
    handle: row.handle,
    display_name: row.displayName,
    description: row.description,
    created_at: timestamp(row.createdAt),
  };
}

function instanceStatus(row: InstanceRow, now: Date): Instance["status"] {
  if (row.state === "ended") return "ended";
  if (row.state === "revoked") return "revoked";
  if (row.tokenExpiresAt !== null && now >= row.tokenExpiresAt) return "expired";
  if (now >= row.leaseExpiresAt) return "offline";
  return "online";
}

function projectInstance(row: InstanceRow, now: Date): Instance {
  return {
    id: row.id,
    principal_id: row.principalId,
    agent_id: row.agentId,
    runtime_kind: row.runtimeKind,
    cli_version: row.cliVersion,
    runtime_metadata: { ...(row.runtimeMetadata ?? {}) },
    reach: row.reach,
    status: instanceStatus(row, now),
    display_name: row.displayName ?? null,
    started_at: timestamp(row.startedAt),
    last_seen_at: timestamp(row.lastSeenAt),
    lease_expires_at: timestamp(row.leaseExpiresAt),
    token_expires_at: row.tokenExpiresAt ? timestamp(row.tokenExpiresAt) : null,
    ended_at: row.endedAt ? timestamp(row.endedAt) : null,
    revoked_at: row.revokedAt ? timestamp(row.revokedAt) : null,
  };
}

// Tags are derived at read time from the acting Instance, never stored beside
// the fact, so every projection below takes the current tag as an argument.
function projectRoom(row: RoomRow, creatorAgentId: AgentId | null): Room {
  return {
    id: row.id,
    principal_id: row.principalId,
    name: row.name,
    description: row.description,
    state: row.state,
    creator_instance_id: row.creatorInstanceId,
    creator_agent_id: creatorAgentId,
    created_at: timestamp(row.createdAt),
    closed_at: row.closedAt ? timestamp(row.closedAt) : null,
  };
}

/** The kind of Principal behind an Instance: with an account, or anonymous. */
function memberKind(sender: SenderInfo): MemberKind {
  return sender && sender.principalAuthUserId === null ? "guest" : "instance";
}

type MemberInstance = Pick<
  InstanceRow,
  "agentId" | "lastSeenAt" | "displayName" | "runtimeKind" | "cliVersion" | "runtimeMetadata"
> & { invitedByPrincipalId?: PrincipalId | null; principalAuthUserId: string | null };

function projectMembership(
  row: typeof roomMembers.$inferSelect,
  instance: MemberInstance | null,
  now: Date,
): RoomMember {
  const seen = instance ? timestamp(instance.lastSeenAt) : null;
  return {
    room_id: row.roomId,
    member_id: row.instanceId,
    kind: memberKind(instance),
    name: instance?.displayName ?? null,
    principal_id: row.principalId,
    agent_id: instance?.agentId ?? null,
    instance_id: row.instanceId,
    invited_by_principal_id: instance?.invitedByPrincipalId ?? null,
    admitted_by: row.admittedBy,
    invite_id: row.inviteId ?? null,
    added_by_instance_id: row.addedByInstanceId ?? null,
    runtime_kind: instance?.runtimeKind ?? "custom",
    runtime_version: instance?.cliVersion ?? "",
    runtime_metadata: { ...(instance?.runtimeMetadata ?? {}) },
    state: row.state,
    joined_at: timestamp(row.joinedAt),
    left_at: row.leftAt ? timestamp(row.leftAt) : null,
    last_seen_at: seen,
    presence: presenceFor(seen, now),
  };
}

type CliLoginRow = typeof cliLogins.$inferSelect;

function projectDecision(row: typeof decisions.$inferSelect, requesterAgentId: AgentId | null): Decision {
  return {
    id: row.id,
    principal_id: row.principalId,
    mode: row.mode,
    title: row.title,
    description: row.description,
    status: row.status,
    requested_by_agent_id: requesterAgentId,
    requested_by_instance_id: row.requestedByInstanceId,
    requested_for_instance_id: row.requestedForInstanceId ?? null,
    room_id: row.roomId ?? null,
    answer: row.answer ?? null,
    created_at: timestamp(row.createdAt),
    resolved_at: row.resolvedAt ? timestamp(row.resolvedAt) : null,
  };
}

function secureDigestEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
const CLI_LOGIN_TTL_MS = 10 * 60_000;

function projectCliLogin(row: CliLoginRow): CliLogin {
  return {
    id: row.id,
    state: row.state,
    label: row.label,
    bind_instance_ids: [...row.bindInstanceIds],
    principal_id: row.principalId ?? null,
    created_at: timestamp(row.createdAt),
    expires_at: timestamp(row.expiresAt),
    approved_at: row.approvedAt ? timestamp(row.approvedAt) : null,
  };
}

function projectInvite(row: InviteRow): RoomInvite {
  return {
    id: row.id,
    room_id: row.roomId,
    principal_id: row.principalId,
    expires_at: row.expiresAt ? timestamp(row.expiresAt) : null,
    revoked_at: row.revokedAt ? timestamp(row.revokedAt) : null,
    uses: row.uses,
    created_at: timestamp(row.createdAt),
  };
}

function projectMessage(
  row: typeof messages.$inferSelect,
  senderAgentId: AgentId | null,
  sender: SenderInfo,
): Message {
  return {
    id: row.id,
    room_id: row.roomId,
    sequence: row.sequence,
    sender_principal_id: row.senderPrincipalId,
    sender_agent_id: senderAgentId,
    sender_instance_id: row.senderInstanceId!,
    sender: {
      member_id: row.senderInstanceId!,
      kind: memberKind(sender),
      name: sender?.displayName ?? null,
    },
    type: "message",
    content: row.content,
    reply_to_message_id: row.replyToMessageId,
    created_at: timestamp(row.createdAt),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

export class PostgresSharedNetRepository implements SharedNetRepository {
  private readonly database: SharedNetDatabase;
  private readonly now: () => Date;
  private readonly transaction = new AsyncLocalStorage<Transaction>();

  constructor(
    database: SharedNetDatabase,
    options: PostgresRepositoryOptions = {},
  ) {
    this.database = database;
    this.now = options.now ?? (() => new Date());
  }

  async authenticateApiKey(token: string): Promise<PrincipalAuth | null> {
    const keyHash = await defaultKeyHasher(token);
    const now = this.now();
    const [keyRecord] = await this.executor()
      .select({
        id: apiKey.id,
        referenceId: apiKey.referenceId,
        enabled: apiKey.enabled,
        expiresAt: apiKey.expiresAt,
      })
      .from(apiKey)
      .where(eq(apiKey.key, keyHash))
      .limit(1);

    if (
      !keyRecord ||
      !keyRecord.enabled ||
      (keyRecord.expiresAt !== null && keyRecord.expiresAt <= now)
    ) {
      return null;
    }

    return this.inTransaction(async () => {
      let [principal] = await this.executor()
        .select()
        .from(principals)
        .where(eq(principals.authUserId, keyRecord.referenceId))
        .limit(1);

      if (!principal) {
        await this.executor()
          .insert(principals)
          .values({
            id: generatePublicId("p"),
            authUserId: keyRecord.referenceId,
            displayName: null,
            createdAt: now,
          })
          .onConflictDoNothing({ target: principals.authUserId });
        [principal] = await this.executor()
          .select()
          .from(principals)
          .where(eq(principals.authUserId, keyRecord.referenceId))
          .limit(1);
      }

      if (!principal) {
        throw new RepositoryError(500, "internal_error", "Principal provisioning failed.");
      }
      return {
        kind: "api_key",
        principalId: principal.id,
        actorId: keyRecord.id as ApiKeyId,
      };
    });
  }

  async authenticateInstance(token: string): Promise<InstanceAuth | null> {
    const [record] = await this.executor()
      .select()
      .from(instances)
      .where(eq(instances.tokenDigest, digestSecret(token)))
      .limit(1);
    if (!record || instanceStatus(record, this.now()) === "expired") return null;
    if (record.state !== "active") return null;

    // Any authenticated request is presence, for every Instance: a seat that
    // sits in `wait` for an hour is online the whole time, with or without a
    // heartbeat of its own. Throttled so a busy seat does not write on every call.
    const now = this.now();
    if (now.getTime() - record.lastSeenAt.getTime() >= SEEN_REFRESH_MS) {
      await this.executor()
        .update(instances)
        .set({ lastSeenAt: now, leaseExpiresAt: new Date(now.getTime() + PRESENCE_LEASE_MS) })
        .where(eq(instances.id, record.id));
    }

    if (record.issuedByKeyId === null) {
      // An anonymous Principal's Instance: no key to check.
      return {
        kind: "instance",
        principalId: record.principalId,
        instanceId: record.id,
        actorId: record.id,
        anonymous: true,
      };
    }

    const [issuer] = await this.executor()
      .select({ enabled: apiKey.enabled, expiresAt: apiKey.expiresAt })
      .from(apiKey)
      .where(eq(apiKey.id, record.issuedByKeyId))
      .limit(1);
    if (!issuer?.enabled || (issuer.expiresAt !== null && issuer.expiresAt <= now)) {
      return null;
    }

    return {
      kind: "instance",
      principalId: record.principalId,
      instanceId: record.id,
      actorId: record.id,
      anonymous: false,
    };
  }

  async createAgent(
    auth: PrincipalAuth,
    input: CreateAgentRequest,
  ): Promise<{ agent: Agent; created: boolean }> {
    return this.inTransaction(async () => {
      const existing = await this.agentByHandle(auth, input.handle);
      if (existing) return { agent: projectAgent(existing), created: false };

      const [{ total }] = await this.executor()
        .select({ total: count() })
        .from(agents)
        .where(eq(agents.principalId, auth.principalId));
      if (Number(total) >= MAX_AGENTS_PER_PRINCIPAL) {
        throw new RepositoryError(409, "agent_limit_reached", "Agent limit reached.");
      }

      try {
        const [created] = await this.executor()
          .insert(agents)
          .values({
            id: generatePublicId("a"),
            principalId: auth.principalId,
            handle: input.handle,
            displayName: input.display_name ?? null,
            description: input.description ?? null,
            createdAt: this.now(),
          })
          .returning();
        if (!created) {
          throw new RepositoryError(500, "internal_error", "Agent creation failed.");
        }
        return { agent: projectAgent(created), created: true };
      } catch (error) {
        // Lost a race to the same handle: the other writer's row is the answer.
        if (!isUniqueViolation(error)) throw error;
        const winner = await this.agentByHandle(auth, input.handle, this.database);
        if (!winner) throw error;
        return { agent: projectAgent(winner), created: false };
      }
    });
  }

  async listAgents(auth: PrincipalAuth): Promise<{ items: Agent[] }> {
    const rows = await this.executor()
      .select()
      .from(agents)
      .where(eq(agents.principalId, auth.principalId))
      .orderBy(asc(agents.handle), asc(agents.id))
      .limit(MAX_AGENTS_PER_PRINCIPAL);
    return { items: rows.map(projectAgent) };
  }

  async getAgent(auth: PrincipalAuth, agentId: AgentId): Promise<{ agent: Agent }> {
    return { agent: projectAgent(await this.ownedAgent(auth, agentId)) };
  }

  async startInstance(
    auth: PrincipalAuth,
    input: StartInstanceRequest,
    retried = false,
  ): Promise<{ instance: Instance; token: string; heartbeat_after_seconds: 30; created: boolean }> {
    try {
      return await this.inTransaction(async () => {
        if (input.agent_id) await this.ownedAgent(auth, input.agent_id);

        const now = this.now();
        const token = generateSecret("sni");
        const tokenDigest = digestSecret(token);
        const leaseExpiresAt = new Date(now.getTime() + PRESENCE_LEASE_MS);

        // One session, one live Instance. A re-registration of a session that
        // is still active — after a crash, from a second CLI invocation, on a
        // machine that lost its local state — gets the same row and a fresh
        // token rather than a ghost holding a parallel lease.
        if (input.local_instance_key) {
          const [existing] = await this.executor()
            .select()
            .from(instances)
            .where(
              and(
                eq(instances.principalId, auth.principalId),
                eq(instances.localInstanceKey, input.local_instance_key),
                eq(instances.state, "active"),
              ),
            )
            .for("update")
            .limit(1);
          if (existing) {
            const [updated] = await this.executor()
              .update(instances)
              .set({
                tokenDigest,
                issuedByKeyId: auth.actorId,
                runtimeKind: input.runtime_kind,
                cliVersion: input.cli_version,
                ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
                ...(input.runtime_metadata !== undefined
                  ? { runtimeMetadata: input.runtime_metadata }
                  : {}),
                lastSeenAt: now,
                leaseExpiresAt,
                tokenExpiresAt: null,
                ...(input.reach !== undefined ? { reach: input.reach } : {}),
              })
              .where(eq(instances.id, existing.id))
              .returning();
            if (!updated) {
              throw new RepositoryError(500, "internal_error", "Instance re-registration failed.");
            }
            return {
              instance: projectInstance(updated, now),
              token,
              heartbeat_after_seconds: 30 as const,
              created: false,
            };
          }
        }

        const [owner] = await this.executor()
          .select({ defaultReach: principals.defaultReach })
          .from(principals)
          .where(eq(principals.id, auth.principalId))
          .limit(1);
        const [record] = await this.executor()
          .insert(instances)
          .values({
            id: generatePublicId("i"),
            principalId: auth.principalId,
            agentId: input.agent_id ?? null,
            reach: input.reach ?? owner?.defaultReach ?? "public",
            issuedByKeyId: auth.actorId,
            tokenDigest,
            localInstanceKey: input.local_instance_key ?? null,
            runtimeKind: input.runtime_kind,
            cliVersion: input.cli_version,
            runtimeMetadata: input.runtime_metadata ?? {},
            state: "active",
            startedAt: now,
            lastSeenAt: now,
            leaseExpiresAt,
            tokenExpiresAt: null,
            endedAt: null,
            revokedAt: null,
            displayName: null,
            admittedByInviteId: null,
          })
          .returning();
        if (!record) {
          throw new RepositoryError(500, "internal_error", "Instance registration failed.");
        }
        return {
          instance: projectInstance(record, now),
          token,
          heartbeat_after_seconds: 30 as const,
          created: true,
        };
      });
    } catch (error) {
      // Two registrations of one session raced past the lookup; the partial
      // unique index caught the loser. Look again in a fresh transaction.
      if (isUniqueViolation(error) && input.local_instance_key && !retried) {
        return this.startInstance(auth, input, true);
      }
      throw error;
    }
  }

  async getCurrentInstance(auth: InstanceAuth): Promise<{
    principal: Principal;
    agent: Agent | null;
    instance: Instance;
  }> {
    const record = await this.instanceRecord(auth);
    const [principal] = await this.executor()
      .select()
      .from(principals)
      .where(eq(principals.id, auth.principalId))
      .limit(1);
    if (!principal) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    const [agent] = record.agentId
      ? await this.executor()
          .select()
          .from(agents)
          .where(and(eq(agents.id, record.agentId), eq(agents.principalId, auth.principalId)))
          .limit(1)
      : [];
    return {
      principal: projectPrincipal(principal),
      agent: agent ? projectAgent(agent) : null,
      instance: projectInstance(record, this.now()),
    };
  }

  async heartbeat(
    auth: InstanceAuth,
  ): Promise<{ instance: Instance; heartbeat_after_seconds: 30 }> {
    const record = await this.instanceRecord(auth);
    if (record.state !== "active") {
      throw new RepositoryError(409, "instance_offline", "Instance is offline.");
    }
    const now = this.now();
    const [updated] = await this.executor()
      .update(instances)
      .set({
        lastSeenAt: now,
        leaseExpiresAt: new Date(now.getTime() + PRESENCE_LEASE_MS),
      })
      .where(
        and(
          eq(instances.id, auth.instanceId),
          eq(instances.principalId, auth.principalId),
          eq(instances.state, "active"),
        ),
      )
      .returning();
    if (!updated) {
      throw new RepositoryError(409, "instance_offline", "Instance is offline.");
    }
    return { instance: projectInstance(updated, now), heartbeat_after_seconds: 30 };
  }

  async createRoom(
    auth: InstanceAuth,
    input: CreateRoomRequest,
  ): Promise<{ room: Room; membership: RoomMember; admissions: Admission[] }> {
    return this.inTransaction(async () => {
      const creator = await this.requireOnline(auth);
      const createdAt = this.now();
      const [room] = await this.executor()
        .insert(rooms)
        .values({
          id: generatePublicId("rom"),
          principalId: auth.principalId,
          name: input.name,
          description: input.description ?? null,
          state: "open",
          creatorInstanceId: auth.instanceId,
          nextSequence: 1,
          createdAt,
          closedAt: null,
        })
        .returning();
      if (!room) {
        throw new RepositoryError(500, "internal_error", "Room creation failed.");
      }
      const [membership] = await this.executor()
        .insert(roomMembers)
        .values({
          principalId: auth.principalId,
          roomId: room.id,
          instanceId: auth.instanceId,
          state: "active",
          joinedAt: createdAt,
          leftAt: null,
          admittedBy: "room_id",
          inviteId: null,
        })
        .returning();
      if (!membership) {
        throw new RepositoryError(500, "internal_error", "Room membership creation failed.");
      }
      const admissions: Admission[] = [];
      for (const instanceId of input.with ?? []) {
        admissions.push(await this.admit(creator, room, instanceId));
      }
      return {
        room: projectRoom(room, creator.agentId),
        membership: projectMembership(
          membership,
          { ...creator, principalAuthUserId: await this.principalAuthUserId(auth.principalId) },
          createdAt,
        ),
        admissions,
      };
    });
  }

  async describeInvite(token: string): Promise<InviteDescription> {
    const [invite] = await this.executor()
      .select()
      .from(roomInvites)
      .where(eq(roomInvites.tokenDigest, digestSecret(token)))
      .limit(1);
    if (!invite) throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    if (invite.revokedAt !== null) throw new RepositoryError(410, "invite_revoked", "Room invite was revoked.");
    if (invite.expiresAt !== null && invite.expiresAt.getTime() <= this.now().getTime()) {
      throw new RepositoryError(410, "invite_expired", "Room invite has expired.");
    }
    const room = await this.roomById(invite.roomId);
    return {
      room: { id: room.id, name: room.name, state: room.state },
      invite: { id: invite.id, expires_at: invite.expiresAt ? timestamp(invite.expiresAt) : null, uses: invite.uses },
    };
  }

  async listRooms(auth: InstanceAuth): Promise<{ items: Room[] }> {
    await this.instanceRecord(auth);
    const rows = await this.executor()
      .select({ room: rooms })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(eq(roomMembers.instanceId, auth.instanceId), eq(roomMembers.state, "active")))
      .orderBy(desc(rooms.createdAt), desc(rooms.id));
    const items: Room[] = [];
    for (const { room } of rows) items.push(await this.projectRoomRow(room));
    return { items };
  }

  async addRoomMembers(
    auth: InstanceAuth,
    roomId: RoomId,
    input: AddRoomMembersRequest,
  ): Promise<{ admissions: Admission[] }> {
    return this.inTransaction(async () => {
      const requester = await this.requireOnline(auth);
      const room = await this.roomById(roomId);
      await this.requireMembership(auth, room.id);
      if (room.state === "closed") {
        throw new RepositoryError(409, "room_closed", "Room is closed.");
      }
      const admissions: Admission[] = [];
      for (const instanceId of input.with) {
        admissions.push(await this.admit(requester, room, instanceId));
      }
      return { admissions };
    });
  }

  async updateInstance(auth: InstanceAuth, input: UpdateInstanceRequest): Promise<{ instance: Instance }> {
    const record = await this.instanceRecord(auth);
    if (input.reach === undefined) return { instance: projectInstance(record, this.now()) };
    const [updated] = await this.executor()
      .update(instances)
      .set({ reach: input.reach })
      .where(eq(instances.id, record.id))
      .returning();
    if (!updated) throw new RepositoryError(500, "internal_error", "Instance update failed.");
    return { instance: projectInstance(updated, this.now()) };
  }

  async listDecisions(
    auth: InstanceAuth,
    filter: { status?: DecisionStatus },
  ): Promise<{ decisions: Decision[] }> {
    await this.instanceRecord(auth);
    const rows = await this.executor()
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.requestedForInstanceId, auth.instanceId),
          ...(filter.status ? [eq(decisions.status, filter.status)] : []),
        ),
      )
      .orderBy(desc(decisions.createdAt), desc(decisions.id));
    const tags = await this.tagsOf(rows.map((row) => row.requestedByInstanceId));
    return { decisions: rows.map((row) => projectDecision(row, tags.get(row.requestedByInstanceId) ?? null)) };
  }

  async resolveDecision(
    auth: InstanceAuth,
    decisionId: DecisionId,
    input: ResolveDecisionRequest,
  ): Promise<{ decision: Decision; membership: RoomMember | null }> {
    return this.inTransaction(async () => {
      const target = await this.instanceRecord(auth);
      const [decision] = await this.executor()
        .select()
        .from(decisions)
        .where(and(eq(decisions.id, decisionId), eq(decisions.requestedForInstanceId, auth.instanceId)))
        .for("update")
        .limit(1);
      // A Decision that is not addressed to this Instance does not exist for it.
      if (!decision) {
        throw new RepositoryError(404, "decision_not_found", "Decision was not found.");
      }
      if (decision.status !== "pending") {
        throw new RepositoryError(409, "decision_already_resolved", "Decision was already resolved.");
      }
      let membership: RoomMember | null = null;
      const now = this.now();
      if (input.resolution === "approved") {
        const room = decision.roomId ? await this.roomById(decision.roomId) : null;
        if (!room || room.state === "closed") {
          throw new RepositoryError(409, "room_closed", "Room is closed.");
        }
        const seated = await this.seat(room.id, target, "accepted", decision.requestedByInstanceId);
        membership = projectMembership(
          seated,
          { ...target, principalAuthUserId: await this.principalAuthUserId(auth.principalId) },
          now,
        );
      }
      const [updated] = await this.executor()
        .update(decisions)
        .set({ status: input.resolution, resolvedAt: now })
        .where(eq(decisions.id, decision.id))
        .returning();
      if (!updated) throw new RepositoryError(500, "internal_error", "Decision update failed.");
      const tags = await this.tagsOf([updated.requestedByInstanceId]);
      return { decision: projectDecision(updated, tags.get(updated.requestedByInstanceId) ?? null), membership };
    });
  }

  /**
   * One Instance named in `with` (decision 2026-09-06 reach, §3): seated at
   * once when public or the requester's own, asked through a Decision when
   * private, refused otherwise. "refused" never says why, so ids cannot be
   * told apart by asking.
   */
  private async admit(requester: InstanceRow, room: RoomRow, targetId: InstanceId): Promise<Admission> {
    const refused: Admission = { instance_id: targetId, status: "refused", decision_id: null };
    const [target] = await this.executor().select().from(instances).where(eq(instances.id, targetId)).limit(1);
    if (!target || target.state !== "active") return refused;
    const [existing] = await this.executor()
      .select({ state: roomMembers.state })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.instanceId, target.id)))
      .limit(1);
    if (existing?.state === "active") return { instance_id: targetId, status: "member", decision_id: null };
    if (target.principalId === requester.principalId || target.reach === "public") {
      await this.seat(room.id, target, "added", requester.id);
      return { instance_id: targetId, status: "member", decision_id: null };
    }
    const [pending] = await this.executor()
      .select({ id: decisions.id })
      .from(decisions)
      .where(
        and(
          eq(decisions.roomId, room.id),
          eq(decisions.requestedForInstanceId, target.id),
          eq(decisions.status, "pending"),
        ),
      )
      .limit(1);
    if (pending) return { instance_id: targetId, status: "pending", decision_id: pending.id };
    const [decision] = await this.executor()
      .insert(decisions)
      .values({
        id: generatePublicId("dec"),
        principalId: target.principalId,
        mode: "approval",
        title: `${requester.id} wants to add ${target.id} to Room "${room.name}"`,
        description: `Instance ${requester.id} of Principal ${requester.principalId} asked to seat ${target.id} in Room ${room.id} ("${room.name}"). Approve to take the seat; deny to refuse.`,
        status: "pending",
        requestedByInstanceId: requester.id,
        requestedForInstanceId: target.id,
        roomId: room.id,
        answer: null,
        createdAt: this.now(),
        resolvedAt: null,
      })
      .returning({ id: decisions.id });
    if (!decision) throw new RepositoryError(500, "internal_error", "Decision creation failed.");
    return { instance_id: targetId, status: "pending", decision_id: decision.id };
  }

  /** Writes an active membership, reviving a left one, and records who asked. */
  private async seat(
    roomId: RoomId,
    target: InstanceRow,
    admittedBy: "added" | "accepted",
    addedBy: InstanceId,
  ): Promise<typeof roomMembers.$inferSelect> {
    const joinedAt = this.now();
    const [membership] = await this.executor()
      .insert(roomMembers)
      .values({
        principalId: target.principalId,
        roomId,
        instanceId: target.id,
        state: "active",
        joinedAt,
        leftAt: null,
        admittedBy,
        inviteId: null,
        addedByInstanceId: addedBy,
      })
      .onConflictDoUpdate({
        target: [roomMembers.roomId, roomMembers.instanceId],
        set: { state: "active", leftAt: null, joinedAt, admittedBy, inviteId: null, addedByInstanceId: addedBy },
      })
      .returning();
    if (!membership) throw new RepositoryError(500, "internal_error", "Room membership update failed.");
    return membership;
  }

  /** The current tag of each Instance named, for projecting who asked. */
  private async tagsOf(instanceIds: InstanceId[]): Promise<Map<InstanceId, AgentId | null>> {
    const tags = new Map<InstanceId, AgentId | null>();
    if (instanceIds.length === 0) return tags;
    const rows = await this.executor()
      .select({ id: instances.id, agentId: instances.agentId })
      .from(instances)
      .where(inArray(instances.id, instanceIds));
    for (const row of rows) tags.set(row.id, row.agentId ?? null);
    return tags;
  }

  async joinRoom(
    auth: InstanceAuth,
    roomId: RoomId,
    input: JoinRoomRequest = {},
  ): Promise<{ room: Room; membership: RoomMember }> {
    return this.inTransaction(async () => {
      const joiner = await this.requireOnline(auth);
      const room = await this.roomById(roomId);
      if (room.state === "closed") {
        throw new RepositoryError(409, "room_closed", "Room is closed.");
      }
      const invite = input.invite === undefined ? null : await this.usableInvite(input.invite, room.id);
      const joinedAt = this.now();
      const [membership] = await this.executor()
        .insert(roomMembers)
        .values({
          principalId: auth.principalId,
          roomId,
          instanceId: auth.instanceId,
          state: "active",
          joinedAt,
          leftAt: null,
          admittedBy: invite ? "invite" : "room_id",
          inviteId: invite?.id ?? null,
        })
        .onConflictDoUpdate({
          target: [roomMembers.roomId, roomMembers.instanceId],
          set: {
            state: "active",
            leftAt: null,
            joinedAt: sql`CASE WHEN ${roomMembers.state} = 'left' THEN ${joinedAt} ELSE ${roomMembers.joinedAt} END`,
          },
        })
        .returning();
      if (!membership) {
        throw new RepositoryError(500, "internal_error", "Room membership update failed.");
      }
      if (invite && membership.joinedAt.getTime() === joinedAt.getTime()) {
        await this.executor()
          .update(roomInvites)
          .set({ uses: invite.uses + 1 })
          .where(eq(roomInvites.id, invite.id));
      }
      return {
        room: await this.projectRoomRow(room),
        membership: projectMembership(
          membership,
          { ...joiner, principalAuthUserId: await this.principalAuthUserId(auth.principalId) },
          joinedAt,
        ),
      };
    });
  }

  /** The invite behind a token, locked, if it opens this Room and is still usable. */
  private async usableInvite(token: string, roomId: RoomId): Promise<InviteRow> {
    const [invite] = await this.executor()
      .select()
      .from(roomInvites)
      .where(eq(roomInvites.tokenDigest, digestSecret(token)))
      .for("update")
      .limit(1);
    // An invite is bound to one Room; presenting it on another is a bad credential.
    if (!invite || invite.roomId !== roomId) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    if (invite.revokedAt !== null) {
      throw new RepositoryError(410, "invite_revoked", "Room invite was revoked.");
    }
    const now = this.now();
    if (invite.expiresAt !== null && invite.expiresAt.getTime() <= now.getTime()) {
      throw new RepositoryError(410, "invite_expired", "Room invite has expired.");
    }
    return invite;
  }

  async createRoomInvite(input: {
    roomId: RoomId;
    principalId: PrincipalId;
    expiresInSeconds?: number | null;
  }): Promise<{ invite: RoomInvite; token: RitSecret }> {
    const [room] = await this.executor()
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, input.roomId), eq(rooms.principalId, input.principalId)))
      .limit(1);
    if (!room) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    const token = generateSecret("rit");
    const createdAt = this.now();
    const seconds = input.expiresInSeconds ?? 0;
    const [invite] = await this.executor()
      .insert(roomInvites)
      .values({
        id: generatePublicId("inv"),
        roomId: room.id,
        principalId: input.principalId,
        tokenDigest: digestSecret(token),
        expiresAt: seconds > 0 ? new Date(createdAt.getTime() + seconds * 1000) : null,
        revokedAt: null,
        uses: 0,
        createdAt,
      })
      .returning();
    if (!invite) {
      throw new RepositoryError(500, "internal_error", "Invite creation failed.");
    }
    return { invite: projectInvite(invite), token };
  }

  async revokeRoomInvite(input: {
    inviteId: InviteId;
    principalId: PrincipalId;
  }): Promise<{ invite: RoomInvite }> {
    const [invite] = await this.executor()
      .update(roomInvites)
      .set({ revokedAt: sql`COALESCE(${roomInvites.revokedAt}, ${this.now()})` })
      .where(
        and(eq(roomInvites.id, input.inviteId), eq(roomInvites.principalId, input.principalId)),
      )
      .returning();
    if (!invite) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    return { invite: projectInvite(invite) };
  }

  async joinRoomWithInvite(
    token: string,
    roomId: RoomId,
    input: JoinRoomWithInviteRequest,
  ): Promise<{
    room: Room;
    membership: RoomMember;
    member_token: SniSecret;
    history: Page<Message>;
  }> {
    return this.inTransaction(async () => {
      const invite = await this.usableInvite(token, roomId);
      const room = await this.roomById(invite.roomId);
      if (room.state === "closed") {
        throw new RepositoryError(409, "room_closed", "Room is closed.");
      }
      const now = this.now();
      // The Agent arrived with nothing but the invite: it gets a Principal of
      // its own, anonymous until someone binds it, and an Instance under it.
      const [principal] = await this.executor()
        .insert(principals)
        .values({
          id: generatePublicId("p"),
          authUserId: null,
          displayName: input.name,
          createdAt: now,
          invitedByPrincipalId: invite.principalId,
          mergedIntoPrincipalId: null,
          defaultReach: "public",
        })
        .returning();
      if (!principal) {
        throw new RepositoryError(500, "internal_error", "Principal creation failed.");
      }
      const memberToken = generateSecret("sni");
      const runtime = input.runtime;
      const runtimeMetadata: Record<string, string> = runtime
        ? {
            runtime_source: runtime.source ?? "declared",
            ...(runtime.version ? { driver_version: runtime.version } : {}),
            ...(runtime.entrypoint ? { entrypoint: runtime.entrypoint } : {}),
          }
        : {};
      const [instance] = await this.executor()
        .insert(instances)
        .values({
          id: generatePublicId("i"),
          principalId: principal.id,
          agentId: null,
          issuedByKeyId: null,
          admittedByInviteId: invite.id,
          displayName: input.name,
          reach: input.reach ?? "public",
          tokenDigest: digestSecret(memberToken),
          localInstanceKey: null,
          runtimeKind: runtime?.kind ?? "custom",
          cliVersion: runtime?.version ?? "invite",
          runtimeMetadata,
          state: "active",
          startedAt: now,
          lastSeenAt: now,
          leaseExpiresAt: new Date(now.getTime() + PRESENCE_LEASE_MS),
          tokenExpiresAt: null,
          endedAt: null,
          revokedAt: null,
        })
        .returning();
      if (!instance) {
        throw new RepositoryError(500, "internal_error", "Instance creation failed.");
      }
      const [membership] = await this.executor()
        .insert(roomMembers)
        .values({
          principalId: principal.id,
          roomId: room.id,
          instanceId: instance.id,
          state: "active",
          joinedAt: now,
          leftAt: null,
          admittedBy: "invite",
          inviteId: invite.id,
        })
        .returning();
      if (!membership) {
        throw new RepositoryError(500, "internal_error", "Room membership creation failed.");
      }
      await this.executor()
        .update(roomInvites)
        .set({ uses: invite.uses + 1 })
        .where(eq(roomInvites.id, invite.id));
      return {
        room: await this.projectRoomRow(room),
        membership: projectMembership(
          membership,
          { ...instance, invitedByPrincipalId: principal.invitedByPrincipalId, principalAuthUserId: null },
          now,
        ),
        member_token: memberToken,
        history: await this.pageMessages(room.id, { after: 0, limit: 100 }),
      };
    });
  }

  async getRoom(
    auth: RoomAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; memberships: RoomMember[] }> {
    const room = await this.roomById(roomId);
    await this.requireMembership(auth, room.id);
    return { room: await this.projectRoomRow(room), memberships: await this.membershipsOf(room.id) };
  }

  /** Every seat of a Room, joined to its Instance and Principal, oldest first. */
  private async membershipsOf(roomId: RoomId, onlyInstanceId?: InstanceId): Promise<RoomMember[]> {
    const now = this.now();
    const rows = await this.executor()
      .select({
        member: roomMembers,
        agentId: instances.agentId,
        lastSeenAt: instances.lastSeenAt,
        displayName: instances.displayName,
        principalAuthUserId: principals.authUserId,
        runtimeKind: instances.runtimeKind,
        cliVersion: instances.cliVersion,
        runtimeMetadata: instances.runtimeMetadata,
        invitedByPrincipalId: principals.invitedByPrincipalId,
      })
      .from(roomMembers)
      .innerJoin(instances, eq(instances.id, roomMembers.instanceId))
      .innerJoin(principals, eq(principals.id, roomMembers.principalId))
      .where(
        onlyInstanceId
          ? and(eq(roomMembers.roomId, roomId), eq(roomMembers.instanceId, onlyInstanceId))
          : eq(roomMembers.roomId, roomId),
      )
      .orderBy(asc(roomMembers.joinedAt));
    return rows.map((row) =>
      projectMembership(
        row.member,
        {
          agentId: row.agentId,
          lastSeenAt: row.lastSeenAt,
          displayName: row.displayName,
          principalAuthUserId: row.principalAuthUserId,
          runtimeKind: row.runtimeKind,
          cliVersion: row.cliVersion,
          runtimeMetadata: row.runtimeMetadata,
          invitedByPrincipalId: row.invitedByPrincipalId,
        },
        now,
      ),
    );
  }

  // ---- The Dashboard's door: Principal-scoped, the same rules as the API. ----

  async principalForAccount(authUserId: string): Promise<Principal | null> {
    const [row] = await this.executor().select().from(principals).where(eq(principals.authUserId, authUserId)).limit(1);
    return row ? projectPrincipal(row) : null;
  }

  /** A Room the Principal scheduled, or has an active seat in; anything else is absent. */
  private async roomVisibleTo(principalId: PrincipalId, roomId: RoomId): Promise<RoomRow> {
    const [room] = await this.executor().select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    if (room && room.principalId === principalId) return room;
    const [seat] = room
      ? await this.executor()
          .select({ instanceId: roomMembers.instanceId })
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.principalId, principalId), eq(roomMembers.state, "active")))
          .limit(1)
      : [];
    if (!room || !seat) throw new RepositoryError(404, "room_not_found", "Room was not found.");
    return room;
  }

  private async ownedRoom(principalId: PrincipalId, roomId: RoomId): Promise<RoomRow> {
    const [room] = await this.executor().select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    if (!room || room.principalId !== principalId) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    return room;
  }

  async listRoomsForPrincipal(principalId: PrincipalId): Promise<{ items: RoomOverview[] }> {
    const seated = this.executor()
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(and(eq(roomMembers.principalId, principalId), eq(roomMembers.state, "active")));
    const roomRows = await this.executor()
      .select()
      .from(rooms)
      .where(or(eq(rooms.principalId, principalId), inArray(rooms.id, seated)))
      .orderBy(desc(rooms.createdAt), desc(rooms.id));
    if (roomRows.length === 0) return { items: [] };
    const counts = await this.executor()
      .select({ roomId: roomMembers.roomId, active: count() })
      .from(roomMembers)
      .where(and(inArray(roomMembers.roomId, roomRows.map((room) => room.id)), eq(roomMembers.state, "active")))
      .groupBy(roomMembers.roomId);
    const activeByRoom = new Map(counts.map((row) => [row.roomId as string, Number(row.active)]));
    const items: RoomOverview[] = [];
    for (const room of roomRows) {
      items.push({
        room: await this.projectRoomRow(room),
        active_member_count: activeByRoom.get(room.id as string) ?? 0,
        latest_sequence: room.nextSequence - 1,
      });
    }
    return { items };
  }

  async getRoomForPrincipal(
    principalId: PrincipalId,
    roomId: RoomId,
  ): Promise<{ room: Room; memberships: RoomMember[]; messages: Message[]; latest_sequence: number }> {
    const room = await this.roomVisibleTo(principalId, roomId);
    const rows = await this.executor()
      .select({
        message: messages,
        agentId: instances.agentId,
        displayName: instances.displayName,
        principalAuthUserId: principals.authUserId,
      })
      .from(messages)
      .innerJoin(instances, eq(instances.id, messages.senderInstanceId))
      .innerJoin(principals, eq(principals.id, messages.senderPrincipalId))
      .where(eq(messages.roomId, room.id))
      .orderBy(asc(messages.sequence));
    return {
      room: await this.projectRoomRow(room),
      memberships: await this.membershipsOf(room.id),
      messages: rows.map((row) =>
        projectMessage(row.message, row.agentId ?? null, { displayName: row.displayName, principalAuthUserId: row.principalAuthUserId }),
      ),
      latest_sequence: room.nextSequence - 1,
    };
  }

  async listDecisionsForPrincipal(principalId: PrincipalId): Promise<{ decisions: DecisionOverview[] }> {
    const rows = await this.executor()
      .select({ decision: decisions, askerPrincipalId: instances.principalId, askerAgentId: instances.agentId })
      .from(decisions)
      .leftJoin(instances, eq(instances.id, decisions.requestedByInstanceId))
      .where(eq(decisions.principalId, principalId))
      .orderBy(desc(decisions.createdAt), desc(decisions.id));
    return {
      decisions: rows.map((row) => ({
        decision: projectDecision(row.decision, row.askerAgentId ?? null),
        requested_by_principal_id: row.askerPrincipalId ?? row.decision.principalId,
      })),
    };
  }

  async resolveDecisionForPrincipal(
    principalId: PrincipalId,
    decisionId: DecisionId,
    answer: DecisionAnswer,
  ): Promise<{ decision: DecisionOverview; membership: RoomMember | null }> {
    // One transaction: the Decision is locked, moved, and the seat it grants
    // written together, so "approved but never seated" cannot be left behind.
    return this.inTransaction(async () => {
      const [decision] = await this.executor()
        .select()
        .from(decisions)
        .where(and(eq(decisions.id, decisionId), eq(decisions.principalId, principalId)))
        .for("update")
        .limit(1);
      if (!decision) {
        throw new RepositoryError(404, "decision_not_found", "Decision was not found.");
      }
      if (decision.status !== "pending") {
        throw new RepositoryError(409, "decision_already_resolved", "Decision was already resolved.");
      }
      if ((decision.mode === "text") !== (answer.outcome === "answered")) {
        throw new RepositoryError(422, "decision_resolution_invalid", "Resolution does not match the Decision mode.");
      }
      let membership: RoomMember | null = null;
      if (answer.outcome === "approved" && decision.requestedForInstanceId && decision.roomId) {
        const room = await this.roomById(decision.roomId);
        if (room.state === "closed") {
          throw new RepositoryError(409, "room_closed", "Room is closed.");
        }
        const [target] = await this.executor()
          .select()
          .from(instances)
          .where(eq(instances.id, decision.requestedForInstanceId))
          .limit(1);
        if (!target) throw new RepositoryError(404, "instance_not_found", "Instance was not found.");
        await this.seat(room.id, target, "accepted", decision.requestedByInstanceId);
        [membership = null] = await this.membershipsOf(room.id, target.id);
      }
      const [updated] = await this.executor()
        .update(decisions)
        .set({
          status: answer.outcome,
          answer: answer.outcome === "answered" ? answer.answer : null,
          resolvedAt: this.now(),
        })
        .where(eq(decisions.id, decision.id))
        .returning();
      if (!updated) throw new RepositoryError(500, "internal_error", "Decision update failed.");
      const [asker] = await this.executor()
        .select({ principalId: instances.principalId, agentId: instances.agentId })
        .from(instances)
        .where(eq(instances.id, updated.requestedByInstanceId))
        .limit(1);
      return {
        decision: {
          decision: projectDecision(updated, asker?.agentId ?? null),
          requested_by_principal_id: asker?.principalId ?? updated.principalId,
        },
        membership,
      };
    });
  }

  async networkForPrincipal(principalId: PrincipalId): Promise<NetworkView> {
    const [principalRow] = await this.executor().select().from(principals).where(eq(principals.id, principalId)).limit(1);
    if (!principalRow) throw new RepositoryError(404, "principal_not_found", "Principal was not found.");
    const now = this.now();
    // The Rooms this Principal scheduled or holds an active seat in.
    const seated = this.executor()
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(and(eq(roomMembers.principalId, principalId), eq(roomMembers.state, "active")));
    const visibleRooms = this.executor()
      .select({ id: rooms.id })
      .from(rooms)
      .where(or(eq(rooms.principalId, principalId), inArray(rooms.id, seated)));
    // Every active seat in those Rooms, with the Instance behind it.
    const seats = await this.executor()
      .select({ roomId: roomMembers.roomId, instanceId: roomMembers.instanceId, principalId: instances.principalId })
      .from(roomMembers)
      .innerJoin(instances, eq(instances.id, roomMembers.instanceId))
      .where(and(inArray(roomMembers.roomId, visibleRooms), eq(roomMembers.state, "active")));
    const coMemberIds = [...new Set(seats.map((seat) => seat.instanceId))];
    const connectedIds = [...new Set(seats.map((seat) => seat.principalId).filter((id) => id !== principalId))];
    const visiblePrincipalIds = [principalId, ...connectedIds];
    const [agentRows, instanceRows, connectedRows] = await Promise.all([
      this.executor()
        .select()
        .from(agents)
        .where(inArray(agents.principalId, visiblePrincipalIds))
        .orderBy(asc(agents.createdAt), asc(agents.id)),
      this.executor()
        .select()
        .from(instances)
        .where(
          coMemberIds.length > 0
            ? or(eq(instances.principalId, principalId), inArray(instances.id, coMemberIds))
            : eq(instances.principalId, principalId),
        )
        .orderBy(desc(instances.startedAt), desc(instances.id)),
      connectedIds.length > 0
        ? this.executor().select().from(principals).where(inArray(principals.id, connectedIds))
        : Promise.resolve([] as (typeof principals.$inferSelect)[]),
    ]);
    const byRoom = new Map<RoomId, InstanceId[]>();
    for (const seat of seats) byRoom.set(seat.roomId, [...(byRoom.get(seat.roomId) ?? []), seat.instanceId]);
    return {
      principal: projectPrincipal(principalRow),
      agents: agentRows.map(projectAgent),
      instances: instanceRows.map((row) => projectInstance(row, now)),
      connected_principals: connectedRows.map(projectPrincipal),
      edges: sharedRoomsEdges([...byRoom.values()]),
    };
  }

  async seatsOf(instanceIds: InstanceId[]): Promise<{ seats: SeatOverview[] }> {
    if (instanceIds.length === 0) return { seats: [] };
    const now = this.now();
    const rows = await this.executor()
      .select({ instance: instances, roomId: roomMembers.roomId, roomName: rooms.name })
      .from(instances)
      .leftJoin(roomMembers, eq(roomMembers.instanceId, instances.id))
      .leftJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(inArray(instances.id, instanceIds))
      .orderBy(asc(instances.startedAt), asc(instances.id));
    const byInstance = new Map<InstanceId, SeatOverview>();
    for (const row of rows) {
      const seat = byInstance.get(row.instance.id) ?? { instance: projectInstance(row.instance, now), rooms: [] };
      if (row.roomId && row.roomName !== null) seat.rooms.push({ id: row.roomId, name: row.roomName });
      byInstance.set(row.instance.id, seat);
    }
    return { seats: [...byInstance.values()] };
  }

  async scheduleRoom(
    principalId: PrincipalId,
    input: { name: string; description: string | null },
  ): Promise<{ room: Room }> {
    const [owner] = await this.executor().select({ id: principals.id }).from(principals).where(eq(principals.id, principalId)).limit(1);
    if (!owner) throw new RepositoryError(404, "principal_not_found", "Principal was not found.");
    const [room] = await this.executor()
      .insert(rooms)
      .values({
        id: generatePublicId("rom"),
        principalId,
        name: input.name,
        description: input.description,
        state: "open",
        creatorInstanceId: null,
        nextSequence: 1,
        createdAt: this.now(),
        closedAt: null,
      })
      .returning();
    if (!room) throw new RepositoryError(500, "internal_error", "Room creation failed.");
    return { room: projectRoom(room, null) };
  }

  async closeRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room }> {
    const room = await this.ownedRoom(principalId, roomId);
    if (room.state === "closed") return { room: await this.projectRoomRow(room) };
    const [closed] = await this.executor()
      .update(rooms)
      .set({ state: "closed", closedAt: this.now() })
      .where(eq(rooms.id, room.id))
      .returning();
    if (!closed) throw new RepositoryError(500, "internal_error", "Room close failed.");
    return { room: await this.projectRoomRow(closed) };
  }

  async removeRoomMember(
    principalId: PrincipalId,
    roomId: RoomId,
    instanceId: InstanceId,
  ): Promise<{ membership: RoomMember }> {
    const room = await this.ownedRoom(principalId, roomId);
    const [member] = await this.executor()
      .select({ state: roomMembers.state })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.instanceId, instanceId)))
      .limit(1);
    if (!member) throw new RepositoryError(404, "member_not_found", "Member was not found.");
    if (member.state === "active") {
      await this.executor()
        .update(roomMembers)
        .set({ state: "left", leftAt: this.now() })
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.instanceId, instanceId)));
    }
    const [membership] = await this.membershipsOf(room.id, instanceId);
    if (!membership) throw new RepositoryError(404, "member_not_found", "Member was not found.");
    return { membership };
  }

  async postMessage(
    auth: RoomAuth,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null },
  ): Promise<{ message: Message }> {
    return this.inTransaction(async () => {
      const sender = await this.requireOnline(auth);
      const [room] = await this.executor()
        .select()
        .from(rooms)
        .where(eq(rooms.id, roomId))
        .for("update")
        .limit(1);
      if (!room) {
        throw new RepositoryError(404, "room_not_found", "Room was not found.");
      }
      if (room.state === "closed") {
        throw new RepositoryError(409, "room_closed", "Room is closed.");
      }
      await this.requireMembership(auth, room.id);

      const replyId = input.reply_to_message_id ?? null;
      if (replyId) {
        const [reply] = await this.executor()
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, replyId), eq(messages.roomId, room.id)))
          .limit(1);
        if (!reply) {
          throw new RepositoryError(422, "reply_target_invalid", "Reply target is invalid.");
        }
      }

      const createdAt = this.now();
      const [message] = await this.executor()
        .insert(messages)
        .values({
          id: generatePublicId("msg"),
          roomId: room.id,
          sequence: room.nextSequence,
          senderPrincipalId: auth.principalId,
          senderInstanceId: auth.instanceId,
          senderGuestId: null,
          content: input.content,
          replyToMessageId: replyId,
          createdAt,
        })
        .returning();
      if (!message) {
        throw new RepositoryError(500, "internal_error", "Message creation failed.");
      }
      await this.executor()
        .update(rooms)
        .set({ nextSequence: room.nextSequence + 1 })
        .where(eq(rooms.id, room.id));
      return {
        message: projectMessage(message, sender.agentId ?? null, {
          displayName: sender.displayName,
          principalAuthUserId: await this.principalAuthUserId(auth.principalId),
        }),
      };
    });
  }

  async listMessages(
    auth: RoomAuth,
    roomId: RoomId,
    input: { after: number; limit: number },
  ): Promise<Page<Message>> {
    const room = await this.roomById(roomId);
    await this.requireMembership(auth, room.id);
    return this.pageMessages(room.id, input);
  }

  async listInbox(
    auth: RoomAuth,
    input: { after: InboxPosition | null; limit: number },
  ): Promise<Page<Message>> {
    const after = input.after;
    // Membership is checked per message row, so a Room the caller left or was
    // removed from drops out of the inbox at once, and a guest never sees past
    // its one Room.
    const membership = sql`EXISTS (SELECT 1 FROM ${roomMembers} WHERE ${roomMembers.roomId} = ${messages.roomId} AND ${roomMembers.instanceId} = ${auth.instanceId} AND ${roomMembers.state} = 'active')`;
    const position =
      after === null
        ? undefined
        : sql`(${messages.createdAt}, ${messages.roomId}, ${messages.sequence}) > (${new Date(after.created_at)}::timestamptz, ${after.room_id}, ${after.sequence})`;
    const rows = await this.executor()
      .select({
        message: messages,
        agentId: instances.agentId,
        displayName: instances.displayName,
        principalAuthUserId: principals.authUserId,
      })
      .from(messages)
      .innerJoin(instances, eq(instances.id, messages.senderInstanceId))
      .innerJoin(principals, eq(principals.id, messages.senderPrincipalId))
      .where(position ? and(membership, position) : membership)
      .orderBy(asc(messages.createdAt), asc(messages.roomId), asc(messages.sequence))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((row) =>
      projectMessage(row.message, row.agentId ?? null, {
        displayName: row.displayName,
        principalAuthUserId: row.principalAuthUserId,
      }),
    );
    const last = items.at(-1);
    return {
      items,
      next_cursor: last
        ? encodeInboxCursor({ created_at: last.created_at, room_id: last.room_id, sequence: last.sequence })
        : after
          ? encodeInboxCursor(after)
          : null,
      has_more: hasMore,
    };
  }

  private async pageMessages(
    roomId: RoomId,
    input: { after: number; limit: number },
  ): Promise<Page<Message>> {
    const rows = await this.executor()
      .select({
        message: messages,
        agentId: instances.agentId,
        displayName: instances.displayName,
        principalAuthUserId: principals.authUserId,
      })
      .from(messages)
      .innerJoin(instances, eq(instances.id, messages.senderInstanceId))
      .innerJoin(principals, eq(principals.id, messages.senderPrincipalId))
      .where(and(eq(messages.roomId, roomId), gt(messages.sequence, input.after)))
      .orderBy(asc(messages.sequence))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((row) =>
      projectMessage(row.message, row.agentId ?? null, {
        displayName: row.displayName,
        principalAuthUserId: row.principalAuthUserId,
      }),
    );
    return {
      items,
      next_cursor:
        items.length > 0
          ? String(items[items.length - 1]!.sequence)
          : input.after > 0
            ? String(input.after)
            : null,
      has_more: hasMore,
    };
  }

  async startCliLogin(input: {
    label: string | null;
    seats: string[];
  }): Promise<{ login: CliLogin; user_code: string; poll_token: ClpSecret }> {
    const now = this.now();
    const bind: InstanceId[] = [];
    for (const seat of input.seats) {
      // Proof of possession: only a live seat of an anonymous, unbound Principal counts.
      const [row] = await this.executor()
        .select({ instance: instances, principal: principals })
        .from(instances)
        .innerJoin(principals, eq(principals.id, instances.principalId))
        .where(eq(instances.tokenDigest, digestSecret(seat)))
        .limit(1);
      if (!row || row.instance.issuedByKeyId !== null || row.instance.state !== "active") continue;
      if (row.principal.authUserId !== null || row.principal.mergedIntoPrincipalId !== null) continue;
      if (!bind.includes(row.instance.id)) bind.push(row.instance.id);
    }
    const code = generateCliLoginCode();
    const pollToken = generateSecret("clp");
    const [record] = await this.executor()
      .insert(cliLogins)
      .values({
        id: generatePublicId("cli"),
        codeDigest: digestSecret(code),
        pollTokenDigest: digestSecret(pollToken),
        label: input.label,
        state: "pending",
        bindInstanceIds: bind,
        principalId: null,
        apiKeyId: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + CLI_LOGIN_TTL_MS),
        approvedAt: null,
        consumedAt: null,
      })
      .returning();
    if (!record) throw new RepositoryError(500, "internal_error", "CLI login creation failed.");
    return { login: projectCliLogin(record), user_code: code, poll_token: pollToken };
  }

  private async cliLoginByCode(code: string): Promise<CliLoginRow | null> {
    const [record] = await this.executor()
      .select()
      .from(cliLogins)
      .where(eq(cliLogins.codeDigest, digestSecret(code)))
      .for("update")
      .limit(1);
    return record ?? null;
  }

  private cliLoginState(record: CliLoginRow): CliLoginRow["state"] {
    if (record.state === "pending" && record.expiresAt.getTime() <= this.now().getTime()) return "expired";
    return record.state;
  }

  async getCliLoginByCode(code: string): Promise<{ login: CliLogin } | null> {
    const [record] = await this.executor()
      .select()
      .from(cliLogins)
      .where(eq(cliLogins.codeDigest, digestSecret(code)))
      .limit(1);
    if (!record) return null;
    return { login: projectCliLogin({ ...record, state: this.cliLoginState(record) }) };
  }

  async approveCliLogin(input: {
    code: string;
    principalId: PrincipalId;
  }): Promise<{ login: CliLogin; bound_principal_ids: PrincipalId[] }> {
    return this.inTransaction(async () => {
      const record = await this.cliLoginByCode(input.code);
      if (!record) throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
      const state = this.cliLoginState(record);
      if (state === "expired") throw new RepositoryError(410, "login_expired", "CLI login has expired.");
      if (state === "denied") throw new RepositoryError(410, "login_denied", "CLI login was denied.");
      if (state !== "pending") throw new RepositoryError(410, "login_consumed", "CLI login was already used.");
      const [account] = await this.executor()
        .select()
        .from(principals)
        .where(eq(principals.id, input.principalId))
        .limit(1);
      if (!account || account.authUserId === null) {
        throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
      }
      const bound: PrincipalId[] = [];
      for (const instanceId of record.bindInstanceIds) {
        const [row] = await this.executor()
          .select({ principal: principals })
          .from(instances)
          .innerJoin(principals, eq(principals.id, instances.principalId))
          .where(eq(instances.id, instanceId))
          .limit(1);
        const anonymous = row?.principal;
        if (!anonymous || anonymous.id === account.id) continue;
        if (anonymous.authUserId !== null || anonymous.mergedIntoPrincipalId !== null) continue;
        // Binding: every Instance of the anonymous Principal moves under the
        // account's Principal. Memberships, messages, Rooms and Decisions carry
        // the Instance's Principal beside its id and follow by ON UPDATE CASCADE.
        await this.executor()
          .update(instances)
          .set({ principalId: account.id })
          .where(eq(instances.principalId, anonymous.id));
        await this.executor()
          .update(principals)
          .set({ mergedIntoPrincipalId: account.id })
          .where(eq(principals.id, anonymous.id));
        bound.push(anonymous.id);
      }
      const now = this.now();
      const [updated] = await this.executor()
        .update(cliLogins)
        .set({ state: "approved", principalId: account.id, approvedAt: now })
        .where(eq(cliLogins.id, record.id))
        .returning();
      if (!updated) throw new RepositoryError(500, "internal_error", "CLI login approval failed.");
      return { login: projectCliLogin(updated), bound_principal_ids: bound };
    });
  }

  async createCliClaim(input: { principalId: PrincipalId; label: string | null }): Promise<{ login: CliLogin; claim: ClpSecret }> {
    const [principal] = await this.executor().select({ id: principals.id }).from(principals).where(eq(principals.id, input.principalId)).limit(1);
    if (!principal) throw new RepositoryError(404, "principal_not_found", "Principal was not found.");
    const now = this.now();
    const claim = generateSecret("clp");
    const [record] = await this.executor()
      .insert(cliLogins)
      .values({
        id: generatePublicId("cli"),
        codeDigest: digestSecret(generateCliLoginCode()),
        pollTokenDigest: digestSecret(claim),
        label: input.label,
        state: "approved",
        bindInstanceIds: [],
        principalId: input.principalId,
        apiKeyId: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + CLI_CLAIM_TTL_MS),
        approvedAt: now,
        consumedAt: null,
      })
      .returning();
    if (!record) throw new RepositoryError(500, "internal_error", "CLI claim creation failed.");
    return { login: projectCliLogin(record), claim };
  }

  async redeemCliClaim(claim: string) {
    const [record] = await this.executor()
      .select({ id: cliLogins.id })
      .from(cliLogins)
      .where(eq(cliLogins.pollTokenDigest, digestSecret(claim)))
      .limit(1);
    if (!record) throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    const polled = await this.pollCliLogin(record.id, claim);
    if (polled.state !== "approved") throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    return polled;
  }

  async pollCliLogin(loginId: CliLoginId, pollToken: string) {
    return this.inTransaction(async () => {
      const [record] = await this.executor()
        .select()
        .from(cliLogins)
        .where(eq(cliLogins.id, loginId))
        .for("update")
        .limit(1);
      if (!record || !secureDigestEquals(digestSecret(pollToken), record.pollTokenDigest)) {
        throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
      }
      const state = this.cliLoginState(record);
      if (state === "expired") throw new RepositoryError(410, "login_expired", "CLI login has expired.");
      if (state === "denied") throw new RepositoryError(410, "login_denied", "CLI login was denied.");
      if (state === "consumed") throw new RepositoryError(410, "login_consumed", "CLI login was already used.");
      if (state === "pending") return { state: "pending" as const, login: projectCliLogin(record) };
      const [principal] = await this.executor()
        .select()
        .from(principals)
        .where(eq(principals.id, record.principalId!))
        .limit(1);
      if (!principal || principal.authUserId === null) {
        throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
      }
      // The key is minted now, at the one moment it is handed over, hashed the
      // way Better Auth hashes the keys the console issues, so no raw key is
      // ever stored and the two kinds of key are indistinguishable to the API.
      const raw = generateSecret("snk");
      const now = this.now();
      const [key] = await this.executor()
        .insert(apiKey)
        .values({
          id: generatePublicId("key"),
          name: record.label ? `sharednet login · ${record.label}` : "sharednet login",
          start: raw.slice(0, 8),
          prefix: "snk_",
          referenceId: principal.authUserId,
          key: await defaultKeyHasher(raw),
          enabled: true,
          rateLimitEnabled: false,
          createdAt: now,
          updatedAt: now,
          metadata: JSON.stringify({ source: "sharednet login", cli_login_id: record.id }),
        })
        .returning({ id: apiKey.id });
      if (!key) throw new RepositoryError(500, "internal_error", "API key creation failed.");
      const [updated] = await this.executor()
        .update(cliLogins)
        .set({ state: "consumed", apiKeyId: key.id as ApiKeyId, consumedAt: now })
        .where(eq(cliLogins.id, record.id))
        .returning();
      if (!updated) throw new RepositoryError(500, "internal_error", "CLI login update failed.");
      return {
        state: "approved" as const,
        login: projectCliLogin(updated),
        api_key: raw,
        api_key_id: key.id as ApiKeyId,
        principal: projectPrincipal(principal),
      };
    });
  }

  async executeIdempotent(
    scope: IdempotencyScope,
    fingerprint: string,
    operation: () => Promise<StoredHttpResult>,
  ): Promise<IdempotencyResult> {
    try {
      return await this.inTransaction(async () => {
        const now = this.now();
        await this.executor()
          .delete(idempotencyRecords)
          .where(lte(idempotencyRecords.expiresAt, now));
        const existing = await this.findIdempotencyRecord(scope);
        if (existing && existing.expiresAt > now) {
          return this.replayIdempotency(existing, fingerprint);
        }
        if (existing) {
          await this.deleteIdempotencyRecord(scope);
        }

        const result = await operation();
        const record: typeof idempotencyRecords.$inferInsert = {
          principalId: scope.principalId,
          credentialClass: scope.credentialClass,
          actorId: scope.actorId,
          operationId: scope.operationId,
          idempotencyKey: scope.key,
          requestFingerprint: fingerprint,
          responseStatus: result.status,
          responseBody: result.body,
          createdAt: now,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
        };
        await this.executor()
          .insert(idempotencyRecords)
          .values(record);
        return { ...result, replayed: false };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findIdempotencyRecord(scope, this.database);
      if (!winner) throw error;
      return this.replayIdempotency(winner, fingerprint);
    }
  }

  private executor(): SharedNetDatabase {
    return (this.transaction.getStore() ?? this.database) as unknown as SharedNetDatabase;
  }

  private async inTransaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transaction.getStore()) return operation();
    return this.database.transaction((transaction) =>
      this.transaction.run(transaction, operation),
    );
  }

  private async instanceRecord(auth: InstanceAuth): Promise<InstanceRow> {
    const [record] = await this.executor()
      .select()
      .from(instances)
      .where(
        and(eq(instances.id, auth.instanceId), eq(instances.principalId, auth.principalId)),
      )
      .limit(1);
    if (!record) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    return record;
  }

  private async ownedAgent(
    auth: PrincipalAuth,
    agentId: AgentId,
  ): Promise<typeof agents.$inferSelect> {
    const [agent] = await this.executor()
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.principalId, auth.principalId)))
      .limit(1);
    if (!agent) {
      throw new RepositoryError(404, "agent_not_found", "Agent was not found.");
    }
    return agent;
  }

  private async agentByHandle(
    auth: PrincipalAuth,
    handle: string,
    database: SharedNetDatabase = this.executor(),
  ): Promise<typeof agents.$inferSelect | undefined> {
    const [agent] = await database
      .select()
      .from(agents)
      .where(and(eq(agents.principalId, auth.principalId), eq(agents.handle, handle)))
      .limit(1);
    return agent;
  }

  /** The tag an Instance is under right now; read, never copied. */
  private async tagOf(instanceId: InstanceId | null): Promise<AgentId | null> {
    if (instanceId === null) return null;
    const [row] = await this.executor()
      .select({ agentId: instances.agentId })
      .from(instances)
      .where(eq(instances.id, instanceId))
      .limit(1);
    return row?.agentId ?? null;
  }

  private async projectRoomRow(room: RoomRow): Promise<Room> {
    return projectRoom(room, await this.tagOf(room.creatorInstanceId));
  }

  /** Null for an anonymous Principal; the account's user id otherwise. */
  private async principalAuthUserId(principalId: PrincipalId): Promise<string | null> {
    const [row] = await this.executor()
      .select({ authUserId: principals.authUserId })
      .from(principals)
      .where(eq(principals.id, principalId))
      .limit(1);
    return row?.authUserId ?? null;
  }

  private async requireOnline(auth: InstanceAuth): Promise<InstanceRow> {
    const record = await this.instanceRecord(auth);
    if (instanceStatus(record, this.now()) !== "online") {
      throw new RepositoryError(409, "instance_offline", "Instance is offline.");
    }
    return record;
  }

  /**
   * A Room id is the capability. Any Instance that knows it may join; reading
   * and posting still require membership, which is checked separately.
   */
  private async roomById(roomId: RoomId): Promise<RoomRow> {
    const [room] = await this.executor()
      .select()
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!room) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    return room;
  }

  private async requireMembership(auth: RoomAuth, roomId: RoomId): Promise<void> {
    const denied = () =>
      new RepositoryError(
        403,
        "room_membership_required",
        "Active Room membership is required.",
      );
    const [membership] = await this.executor()
      .select({ instanceId: roomMembers.instanceId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.principalId, auth.principalId),
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.instanceId, auth.instanceId),
          eq(roomMembers.state, "active"),
        ),
      )
      .limit(1);
    if (!membership) throw denied();
  }

  private async findIdempotencyRecord(
    scope: IdempotencyScope,
    database: SharedNetDatabase = this.executor(),
  ): Promise<typeof idempotencyRecords.$inferSelect | undefined> {
    const [record] = await database
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.principalId, scope.principalId),
          eq(idempotencyRecords.credentialClass, scope.credentialClass),
          eq(idempotencyRecords.actorId, scope.actorId),
          eq(idempotencyRecords.operationId, scope.operationId),
          eq(idempotencyRecords.idempotencyKey, scope.key),
        ),
      )
      .limit(1);
    return record;
  }

  private async deleteIdempotencyRecord(scope: IdempotencyScope): Promise<void> {
    await this.executor()
      .delete(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.principalId, scope.principalId),
          eq(idempotencyRecords.credentialClass, scope.credentialClass),
          eq(idempotencyRecords.actorId, scope.actorId),
          eq(idempotencyRecords.operationId, scope.operationId),
          eq(idempotencyRecords.idempotencyKey, scope.key),
        ),
      );
  }

  private replayIdempotency(
    record: typeof idempotencyRecords.$inferSelect,
    fingerprint: string,
  ): IdempotencyResult {
    if (record.requestFingerprint !== fingerprint) {
      throw new RepositoryError(
        409,
        "idempotency_conflict",
        "Idempotency key was already used for a different request.",
      );
    }
    return {
      status: record.responseStatus,
      body: record.responseBody,
      replayed: true,
    };
  }
}
