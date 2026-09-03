import { AsyncLocalStorage } from "node:async_hooks";

import { defaultKeyHasher } from "@better-auth/api-key";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import {
  agents,
  apiKey,
  idempotencyRecords,
  instances,
  messages,
  principals,
  roomMembers,
  rooms,
  type SharedNetDatabase,
} from "../../db/src/index.ts";
import {
  digestSecret,
  generatePublicId,
  generateSecret,
  type Agent,
  type AgentId,
  type ApiKeyId,
  type Instance,
  type InstanceId,
  type Message,
  type MessageId,
  type Principal,
  type Room,
  type RoomId,
  type RoomMember,
} from "../../protocol/src/index.ts";
import {
  IDEMPOTENCY_RETENTION_MS,
  INSTANCE_TOKEN_TTL_MS,
  PRESENCE_LEASE_MS,
  RepositoryError,
  type IdempotencyResult,
  type IdempotencyScope,
  type InstanceAuth,
  type PrincipalAuth,
  type SharedNetRepository,
  type StoredHttpResult,
} from "./repository.ts";

type Transaction = Parameters<Parameters<SharedNetDatabase["transaction"]>[0]>[0];
type InstanceRow = typeof instances.$inferSelect;
type RoomRow = typeof rooms.$inferSelect;

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
  };
}

function projectAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    principal_id: row.principalId,
    handle: row.handle,
    display_name: row.displayName,
    description: row.description,
    is_default: row.isDefault,
    created_at: timestamp(row.createdAt),
  };
}

function instanceStatus(row: InstanceRow, now: Date): Instance["status"] {
  if (row.state === "ended") return "ended";
  if (row.state === "revoked") return "revoked";
  if (now >= row.tokenExpiresAt) return "expired";
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
    status: instanceStatus(row, now),
    started_at: timestamp(row.startedAt),
    last_seen_at: timestamp(row.lastSeenAt),
    lease_expires_at: timestamp(row.leaseExpiresAt),
    token_expires_at: timestamp(row.tokenExpiresAt),
    ended_at: row.endedAt ? timestamp(row.endedAt) : null,
    revoked_at: row.revokedAt ? timestamp(row.revokedAt) : null,
  };
}

function projectRoom(row: RoomRow): Room {
  return {
    id: row.id,
    principal_id: row.principalId,
    name: row.name,
    description: row.description,
    state: row.state,
    creator_agent_id: row.creatorAgentId,
    created_at: timestamp(row.createdAt),
    closed_at: row.closedAt ? timestamp(row.closedAt) : null,
  };
}

function projectMembership(row: typeof roomMembers.$inferSelect): RoomMember {
  return {
    room_id: row.roomId,
    agent_id: row.agentId,
    state: row.state,
    joined_at: timestamp(row.joinedAt),
    left_at: row.leftAt ? timestamp(row.leftAt) : null,
  };
}

function projectMessage(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    room_id: row.roomId,
    sequence: row.sequence,
    sender_principal_id: row.senderPrincipalId,
    sender_agent_id: row.senderAgentId,
    sender_instance_id: row.senderInstanceId,
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
            id: generatePublicId("pri"),
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
      agentId: record.agentId,
      instanceId: record.id,
      actorId: record.id,
    };
  }

  async ensureDefaultAgent(auth: PrincipalAuth): Promise<Agent> {
    return this.inTransaction(async () => {
      let [agent] = await this.executor()
        .select()
        .from(agents)
        .where(and(eq(agents.principalId, auth.principalId), eq(agents.isDefault, true)))
        .limit(1);
      if (!agent) {
        await this.executor()
          .insert(agents)
          .values({
            id: generatePublicId("agt"),
            principalId: auth.principalId,
            handle: "default",
            displayName: null,
            description: null,
            isDefault: true,
            createdAt: this.now(),
          })
          .onConflictDoNothing();
        [agent] = await this.executor()
          .select()
          .from(agents)
          .where(and(eq(agents.principalId, auth.principalId), eq(agents.isDefault, true)))
          .limit(1);
      }
      if (!agent) {
        throw new RepositoryError(500, "internal_error", "Default Agent provisioning failed.");
      }
      return projectAgent(agent);
    });
  }

  async startInstance(
    auth: PrincipalAuth,
    agentId: AgentId,
    input: { runtime_kind: Instance["runtime_kind"]; cli_version: string },
  ): Promise<{ instance: Instance; token: string; heartbeat_after_seconds: 30 }> {
    return this.inTransaction(async () => {
      const [agent] = await this.executor()
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.principalId, auth.principalId)))
        .limit(1);
      if (!agent) {
        throw new RepositoryError(404, "agent_not_found", "Agent was not found.");
      }

      const now = this.now();
      const token = generateSecret("sni");
      const [record] = await this.executor()
        .insert(instances)
        .values({
          id: generatePublicId("ins"),
          principalId: auth.principalId,
          agentId,
          issuedByKeyId: auth.actorId,
          tokenDigest: digestSecret(token),
          runtimeKind: input.runtime_kind,
          cliVersion: input.cli_version,
          state: "active",
          startedAt: now,
          lastSeenAt: now,
          leaseExpiresAt: new Date(now.getTime() + PRESENCE_LEASE_MS),
          tokenExpiresAt: new Date(now.getTime() + INSTANCE_TOKEN_TTL_MS),
          endedAt: null,
          revokedAt: null,
        })
        .returning();
      if (!record) {
        throw new RepositoryError(500, "internal_error", "Instance registration failed.");
      }
      return {
        instance: projectInstance(record, now),
        token,
        heartbeat_after_seconds: 30,
      };
    });
  }

  async getCurrentInstance(auth: InstanceAuth): Promise<{
    principal: Principal;
    agent: Agent;
    instance: Instance;
  }> {
    const record = await this.instanceRecord(auth);
    const [[principal], [agent]] = await Promise.all([
      this.executor()
        .select()
        .from(principals)
        .where(eq(principals.id, auth.principalId))
        .limit(1),
      this.executor()
        .select()
        .from(agents)
        .where(and(eq(agents.id, auth.agentId), eq(agents.principalId, auth.principalId)))
        .limit(1),
    ]);
    if (!principal || !agent) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    return {
      principal: projectPrincipal(principal),
      agent: projectAgent(agent),
      instance: projectInstance(record, this.now()),
    };
  }

  async heartbeat(
    auth: InstanceAuth,
  ): Promise<{ instance: Instance; heartbeat_after_seconds: 30 }> {
    const record = await this.instanceRecord(auth);
    if (record.state !== "active" || this.now() >= record.tokenExpiresAt) {
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
          eq(instances.agentId, auth.agentId),
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
      await this.requireOnline(auth);
      const createdAt = this.now();
      const [room] = await this.executor()
        .insert(rooms)
        .values({
          id: generatePublicId("rom"),
          principalId: auth.principalId,
          name: input.name,
          description: input.description ?? null,
          state: "open",
          creatorAgentId: auth.agentId,
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
          agentId: auth.agentId,
          state: "active",
          joinedAt: createdAt,
          leftAt: null,
        })
        .returning();
      if (!membership) {
        throw new RepositoryError(500, "internal_error", "Room membership creation failed.");
      }
      return { room: projectRoom(room), membership: projectMembership(membership) };
    });
  }

  async joinRoom(
    auth: InstanceAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; membership: RoomMember }> {
    return this.inTransaction(async () => {
      await this.requireOnline(auth);
      const room = await this.ownedRoom(auth, roomId);
      if (room.state === "closed") {
        throw new RepositoryError(409, "room_closed", "Room is closed.");
      }
      const joinedAt = this.now();
      const [membership] = await this.executor()
        .insert(roomMembers)
        .values({
          principalId: auth.principalId,
          roomId,
          agentId: auth.agentId,
          state: "active",
          joinedAt,
          leftAt: null,
        })
        .onConflictDoUpdate({
          target: [roomMembers.roomId, roomMembers.agentId],
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
      return { room: projectRoom(room), membership: projectMembership(membership) };
    });
  }

  async postMessage(
    auth: InstanceAuth,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null },
  ): Promise<{ message: Message }> {
    return this.inTransaction(async () => {
      await this.requireOnline(auth);
      const [room] = await this.executor()
        .select()
        .from(rooms)
        .where(and(eq(rooms.id, roomId), eq(rooms.principalId, auth.principalId)))
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
          senderAgentId: auth.agentId,
          senderInstanceId: auth.instanceId,
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
      return { message: projectMessage(message) };
    });
  }

  async listMessages(
    auth: InstanceAuth,
    roomId: RoomId,
    input: { after: number; limit: number },
  ): Promise<{ items: Message[]; next_cursor: string | null; has_more: boolean }> {
    const room = await this.ownedRoom(auth, roomId);
    await this.requireMembership(auth, room.id);
    const rows = await this.executor()
      .select()
      .from(messages)
      .where(and(eq(messages.roomId, room.id), gt(messages.sequence, input.after)))
      .orderBy(asc(messages.sequence))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map(projectMessage);
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
        and(
          eq(instances.id, auth.instanceId),
          eq(instances.principalId, auth.principalId),
          eq(instances.agentId, auth.agentId),
        ),
      )
      .limit(1);
    if (!record) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    return record;
  }

  private async requireOnline(auth: InstanceAuth): Promise<InstanceRow> {
    const record = await this.instanceRecord(auth);
    if (instanceStatus(record, this.now()) !== "online") {
      throw new RepositoryError(409, "instance_offline", "Instance is offline.");
    }
    return record;
  }

  private async ownedRoom(auth: InstanceAuth, roomId: RoomId): Promise<RoomRow> {
    const [room] = await this.executor()
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.principalId, auth.principalId)))
      .limit(1);
    if (!room) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    return room;
  }

  private async requireMembership(
    auth: InstanceAuth,
    roomId: RoomId,
  ): Promise<typeof roomMembers.$inferSelect> {
    const [membership] = await this.executor()
      .select()
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.principalId, auth.principalId),
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.agentId, auth.agentId),
          eq(roomMembers.state, "active"),
        ),
      )
      .limit(1);
    if (!membership) {
      throw new RepositoryError(
        403,
        "room_membership_required",
        "Active Room membership is required.",
      );
    }
    return membership;
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
