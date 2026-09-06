import { AsyncLocalStorage } from "node:async_hooks";

import { defaultKeyHasher } from "@better-auth/api-key";
import { and, asc, count, eq, gt, lte, sql } from "drizzle-orm";

import {
  agents,
  apiKey,
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
  INSTANCE_TOKEN_TTL_MS,
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

type Transaction = Parameters<Parameters<SharedNetDatabase["transaction"]>[0]>[0];
type InstanceRow = typeof instances.$inferSelect;
type RoomRow = typeof rooms.$inferSelect;
type InviteRow = typeof roomInvites.$inferSelect;
type PrincipalRow = typeof principals.$inferSelect;
/** What a message or membership needs to know about its Instance to name it. */
type SenderInfo = Pick<InstanceRow, "displayName" | "issuedByKeyId"> | null;

/**
 * An invite-admitted Instance counts as seen at most this often, so `wait`
 * polls do not write on every tick. Any authenticated request is its presence.
 */
const ANONYMOUS_SEEN_REFRESH_MS = 10_000;

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
  return sender?.issuedByKeyId === null ? "guest" : "instance";
}

type MemberInstance = Pick<
  InstanceRow,
  "agentId" | "lastSeenAt" | "displayName" | "issuedByKeyId" | "runtimeKind" | "cliVersion" | "runtimeMetadata"
> & { invitedByPrincipalId?: PrincipalId | null };

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

    if (record.issuedByKeyId === null) {
      // An anonymous Principal's Instance: no key to check, no heartbeat to
      // keep. Any authenticated request is its presence.
      const now = this.now();
      if (now.getTime() - record.lastSeenAt.getTime() >= ANONYMOUS_SEEN_REFRESH_MS) {
        await this.executor()
          .update(instances)
          .set({ lastSeenAt: now, leaseExpiresAt: new Date(now.getTime() + PRESENCE_LEASE_MS) })
          .where(eq(instances.id, record.id));
      }
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
    const now = this.now();
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
        const tokenExpiresAt = new Date(now.getTime() + INSTANCE_TOKEN_TTL_MS);

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
                tokenExpiresAt,
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

        const [record] = await this.executor()
          .insert(instances)
          .values({
            id: generatePublicId("i"),
            principalId: auth.principalId,
            agentId: input.agent_id ?? null,
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
            tokenExpiresAt,
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
    if (
      record.state !== "active" ||
      (record.tokenExpiresAt !== null && this.now() >= record.tokenExpiresAt)
    ) {
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
          gt(instances.tokenExpiresAt, now),
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
    input: { name: string; description?: string | null },
  ): Promise<{ room: Room; membership: RoomMember }> {
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
      return {
        room: projectRoom(room, creator.agentId),
        membership: projectMembership(membership, creator, createdAt),
      };
    });
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
        membership: projectMembership(membership, joiner, joinedAt),
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
          { ...instance, invitedByPrincipalId: principal.invitedByPrincipalId },
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
    const now = this.now();
    const rows = await this.executor()
      .select({
        member: roomMembers,
        agentId: instances.agentId,
        lastSeenAt: instances.lastSeenAt,
        displayName: instances.displayName,
        issuedByKeyId: instances.issuedByKeyId,
        runtimeKind: instances.runtimeKind,
        cliVersion: instances.cliVersion,
        runtimeMetadata: instances.runtimeMetadata,
        invitedByPrincipalId: principals.invitedByPrincipalId,
      })
      .from(roomMembers)
      .innerJoin(instances, eq(instances.id, roomMembers.instanceId))
      .innerJoin(principals, eq(principals.id, roomMembers.principalId))
      .where(eq(roomMembers.roomId, room.id))
      .orderBy(asc(roomMembers.joinedAt));
    return {
      room: await this.projectRoomRow(room),
      memberships: rows.map((row) =>
        projectMembership(
          row.member,
          {
            agentId: row.agentId,
            lastSeenAt: row.lastSeenAt,
            displayName: row.displayName,
            issuedByKeyId: row.issuedByKeyId,
            runtimeKind: row.runtimeKind,
            cliVersion: row.cliVersion,
            runtimeMetadata: row.runtimeMetadata,
            invitedByPrincipalId: row.invitedByPrincipalId,
          },
          now,
        ),
      ),
    };
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
      return { message: projectMessage(message, sender.agentId ?? null, sender) };
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
        issuedByKeyId: instances.issuedByKeyId,
      })
      .from(messages)
      .innerJoin(instances, eq(instances.id, messages.senderInstanceId))
      .where(position ? and(membership, position) : membership)
      .orderBy(asc(messages.createdAt), asc(messages.roomId), asc(messages.sequence))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((row) =>
      projectMessage(row.message, row.agentId ?? null, {
        displayName: row.displayName,
        issuedByKeyId: row.issuedByKeyId,
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
        issuedByKeyId: instances.issuedByKeyId,
      })
      .from(messages)
      .innerJoin(instances, eq(instances.id, messages.senderInstanceId))
      .where(and(eq(messages.roomId, roomId), gt(messages.sequence, input.after)))
      .orderBy(asc(messages.sequence))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((row) =>
      projectMessage(row.message, row.agentId ?? null, {
        displayName: row.displayName,
        issuedByKeyId: row.issuedByKeyId,
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
