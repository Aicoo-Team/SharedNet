import { timingSafeEqual } from "node:crypto";

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
  type PrincipalId,
  type Room,
  type RoomId,
  type RoomMember,
} from "../../protocol/src/index.ts";
import {
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

type ApiKeyRecord = {
  id: ApiKeyId;
  principalId: PrincipalId;
  digest: string;
  revokedAt: string | null;
};

type InstanceRecord = Instance & {
  tokenDigest: string;
  issuedByKeyId: ApiKeyId;
};

type RoomRecord = Room & {
  nextSequence: number;
};

type IdempotencyRecord = StoredHttpResult & {
  fingerprint: string;
};

export { RepositoryError } from "./repository.ts";
export type {
  IdempotencyResult,
  IdempotencyScope,
  InstanceAuth,
  PrincipalAuth,
  SharedNetRepository,
} from "./repository.ts";

export type MemoryRepositoryOptions = {
  devApiKey?: string;
  now?: () => Date;
};

function secureDigestEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function membershipKey(roomId: RoomId, agentId: AgentId): string {
  return `${roomId}\0${agentId}`;
}

function idempotencyKey(scope: IdempotencyScope): string {
  return [
    scope.principalId,
    scope.credentialClass,
    scope.actorId,
    scope.operationId,
    scope.key,
  ].join("\0");
}

export class MemorySharedNetRepository implements SharedNetRepository {
  private readonly now: () => Date;
  private readonly principals = new Map<PrincipalId, Principal>();
  private readonly apiKeysByDigest = new Map<string, ApiKeyRecord>();
  private readonly agents = new Map<AgentId, Agent>();
  private readonly instances = new Map<InstanceId, InstanceRecord>();
  private readonly instanceIdsByDigest = new Map<string, InstanceId>();
  private readonly rooms = new Map<RoomId, RoomRecord>();
  private readonly memberships = new Map<string, RoomMember>();
  private readonly messages = new Map<RoomId, Message[]>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly idempotencyInFlight = new Map<
    string,
    { fingerprint: string; result: Promise<IdempotencyResult> }
  >();

  constructor(options: MemoryRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());

    if (options.devApiKey) {
      const createdAt = this.timestamp();
      const principal: Principal = {
        id: generatePublicId("pri"),
        display_name: null,
        created_at: createdAt,
      };
      const apiKeyRecord: ApiKeyRecord = {
        id: generatePublicId("key"),
        principalId: principal.id,
        digest: digestSecret(options.devApiKey),
        revokedAt: null,
      };
      this.principals.set(principal.id, principal);
      this.apiKeysByDigest.set(apiKeyRecord.digest, apiKeyRecord);
    }
  }

  async authenticateApiKey(token: string): Promise<PrincipalAuth | null> {
    const candidate = digestSecret(token);
    for (const record of this.apiKeysByDigest.values()) {
      if (record.revokedAt === null && secureDigestEquals(candidate, record.digest)) {
        return {
          kind: "api_key",
          principalId: record.principalId,
          actorId: record.id,
        };
      }
    }
    return null;
  }

  async authenticateInstance(token: string): Promise<InstanceAuth | null> {
    const candidate = digestSecret(token);
    let instanceId: InstanceId | undefined;
    for (const [digest, id] of this.instanceIdsByDigest) {
      if (secureDigestEquals(candidate, digest)) {
        instanceId = id;
        break;
      }
    }
    if (!instanceId) return null;

    const record = this.instances.get(instanceId);
    if (!record) return null;
    const issuingKey = [...this.apiKeysByDigest.values()].find(
      (apiKey) => apiKey.id === record.issuedByKeyId,
    );
    const projected = this.projectInstance(record);
    if (
      !issuingKey ||
      issuingKey.revokedAt !== null ||
      projected.status === "ended" ||
      projected.status === "revoked" ||
      projected.status === "expired"
    ) {
      return null;
    }
    return {
      kind: "instance",
      principalId: record.principal_id,
      agentId: record.agent_id,
      instanceId: record.id,
      actorId: record.id,
    };
  }

  async ensureDefaultAgent(auth: PrincipalAuth): Promise<Agent> {
    const existing = [...this.agents.values()].find(
      (agent) => agent.principal_id === auth.principalId && agent.is_default,
    );
    if (existing) return { ...existing };

    const agent: Agent = {
      id: generatePublicId("agt"),
      principal_id: auth.principalId,
      handle: "default",
      display_name: null,
      description: null,
      is_default: true,
      created_at: this.timestamp(),
    };
    this.agents.set(agent.id, agent);
    return { ...agent };
  }

  async startInstance(
    auth: PrincipalAuth,
    agentId: AgentId,
    input: { runtime_kind: Instance["runtime_kind"]; cli_version: string },
  ): Promise<{ instance: Instance; token: string; heartbeat_after_seconds: 30 }> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.principal_id !== auth.principalId) {
      throw new RepositoryError(404, "agent_not_found", "Agent was not found.");
    }

    const now = this.now();
    const token = generateSecret("sni");
    const instance: InstanceRecord = {
      id: generatePublicId("ins"),
      principal_id: auth.principalId,
      agent_id: agent.id,
      runtime_kind: input.runtime_kind,
      cli_version: input.cli_version,
      status: "online",
      started_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString(),
      token_expires_at: new Date(now.getTime() + INSTANCE_TOKEN_TTL_MS).toISOString(),
      ended_at: null,
      revoked_at: null,
      tokenDigest: digestSecret(token),
      issuedByKeyId: auth.actorId,
    };
    this.instances.set(instance.id, instance);
    this.instanceIdsByDigest.set(instance.tokenDigest, instance.id);
    return {
      instance: this.projectInstance(instance),
      token,
      heartbeat_after_seconds: 30,
    };
  }

  async getCurrentInstance(auth: InstanceAuth) {
    const record = this.instanceRecord(auth);
    const principal = this.principals.get(auth.principalId);
    const agent = this.agents.get(auth.agentId);
    if (!principal || !agent) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    return {
      principal: { ...principal },
      agent: { ...agent },
      instance: this.projectInstance(record),
    };
  }

  async heartbeat(auth: InstanceAuth) {
    const record = this.instanceRecord(auth);
    const now = this.now();
    record.last_seen_at = now.toISOString();
    record.lease_expires_at = new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString();
    record.status = "online";
    return {
      instance: this.projectInstance(record),
      heartbeat_after_seconds: 30 as const,
    };
  }

  async createRoom(
    auth: InstanceAuth,
    input: { name: string; description?: string | null },
  ): Promise<{ room: Room; membership: RoomMember }> {
    this.requireOnline(auth);
    const createdAt = this.timestamp();
    const room: RoomRecord = {
      id: generatePublicId("rom"),
      principal_id: auth.principalId,
      name: input.name,
      description: input.description ?? null,
      state: "open",
      creator_agent_id: auth.agentId,
      created_at: createdAt,
      closed_at: null,
      nextSequence: 1,
    };
    const membership: RoomMember = {
      room_id: room.id,
      agent_id: auth.agentId,
      state: "active",
      joined_at: createdAt,
      left_at: null,
    };
    this.rooms.set(room.id, room);
    this.memberships.set(membershipKey(room.id, auth.agentId), membership);
    this.messages.set(room.id, []);
    return { room: this.projectRoom(room), membership: { ...membership } };
  }

  async joinRoom(
    auth: InstanceAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; membership: RoomMember }> {
    this.requireOnline(auth);
    const room = this.ownedRoom(auth, roomId);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    const key = membershipKey(room.id, auth.agentId);
    const existing = this.memberships.get(key);
    const membership: RoomMember =
      existing && existing.state === "active"
        ? existing
        : {
            room_id: room.id,
            agent_id: auth.agentId,
            state: "active",
            joined_at: this.timestamp(),
            left_at: null,
          };
    if (membership !== existing) {
      this.memberships.set(key, membership);
    }
    return { room: this.projectRoom(room), membership: { ...membership } };
  }

  async getRoom(
    auth: InstanceAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; memberships: RoomMember[] }> {
    const room = this.ownedRoom(auth, roomId);
    this.requireMembership(auth, room.id);
    const memberships = [...this.memberships.values()]
      .filter((membership) => membership.room_id === room.id)
      .map((membership) => ({ ...membership }));
    return { room: this.projectRoom(room), memberships };
  }

  async postMessage(
    auth: InstanceAuth,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null },
  ): Promise<{ message: Message }> {
    this.requireOnline(auth);
    const room = this.ownedRoom(auth, roomId);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    this.requireMembership(auth, room.id);

    const roomMessages = this.messages.get(room.id)!;
    const replyId = input.reply_to_message_id ?? null;
    if (replyId && !roomMessages.some((message) => message.id === replyId)) {
      throw new RepositoryError(
        422,
        "reply_target_invalid",
        "Reply target is invalid.",
      );
    }

    const message: Message = {
      id: generatePublicId("msg"),
      room_id: room.id,
      sequence: room.nextSequence,
      sender_principal_id: auth.principalId,
      sender_agent_id: auth.agentId,
      sender_instance_id: auth.instanceId,
      content: input.content,
      reply_to_message_id: replyId,
      created_at: this.timestamp(),
    };
    room.nextSequence += 1;
    roomMessages.push(message);
    return { message: { ...message } };
  }

  async listMessages(
    auth: InstanceAuth,
    roomId: RoomId,
    input: { after: number; limit: number },
  ) {
    const room = this.ownedRoom(auth, roomId);
    this.requireMembership(auth, room.id);
    const matching = (this.messages.get(room.id) ?? []).filter(
      (message) => message.sequence > input.after,
    );
    const items = matching.slice(0, input.limit).map((message) => ({ ...message }));
    return {
      items,
      next_cursor:
        items.length > 0 ? String(items[items.length - 1]!.sequence) : input.after > 0 ? String(input.after) : null,
      has_more: matching.length > items.length,
    };
  }

  async executeIdempotent(
    scope: IdempotencyScope,
    fingerprint: string,
    operation: () => Promise<StoredHttpResult>,
  ): Promise<IdempotencyResult> {
    const key = idempotencyKey(scope);
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new RepositoryError(
          409,
          "idempotency_conflict",
          "Idempotency key was already used for a different request.",
        );
      }
      return { status: existing.status, body: existing.body, replayed: true };
    }

    const inFlight = this.idempotencyInFlight.get(key);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        throw new RepositoryError(
          409,
          "idempotency_conflict",
          "Idempotency key was already used for a different request.",
        );
      }
      const replay = await inFlight.result;
      return { ...replay, replayed: true };
    }

    const pending = (async () => {
      const result = await operation();
      this.idempotency.set(key, { ...result, fingerprint });
      return { ...result, replayed: false };
    })();
    this.idempotencyInFlight.set(key, { fingerprint, result: pending });
    try {
      return await pending;
    } finally {
      this.idempotencyInFlight.delete(key);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private projectInstance(record: InstanceRecord): Instance {
    const now = this.now().getTime();
    let status = record.status;
    if (status !== "ended" && status !== "revoked") {
      if (now >= Date.parse(record.token_expires_at)) status = "expired";
      else if (now >= Date.parse(record.lease_expires_at)) status = "offline";
      else status = "online";
    }
    const {
      tokenDigest: _tokenDigest,
      issuedByKeyId: _issuedByKeyId,
      ...projected
    } = record;
    return { ...projected, status };
  }

  private instanceRecord(auth: InstanceAuth): InstanceRecord {
    const record = this.instances.get(auth.instanceId);
    if (
      !record ||
      record.principal_id !== auth.principalId ||
      record.agent_id !== auth.agentId
    ) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    return record;
  }

  private requireOnline(auth: InstanceAuth): InstanceRecord {
    const record = this.instanceRecord(auth);
    if (this.projectInstance(record).status !== "online") {
      throw new RepositoryError(409, "instance_offline", "Instance is offline.");
    }
    return record;
  }

  private ownedRoom(auth: InstanceAuth, roomId: RoomId): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room || room.principal_id !== auth.principalId) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    return room;
  }

  private requireMembership(auth: InstanceAuth, roomId: RoomId): RoomMember {
    const membership = this.memberships.get(membershipKey(roomId, auth.agentId));
    if (!membership || membership.state !== "active") {
      throw new RepositoryError(
        403,
        "room_membership_required",
        "Active Room membership is required.",
      );
    }
    return membership;
  }

  private projectRoom(room: RoomRecord): Room {
    const { nextSequence: _nextSequence, ...projected } = room;
    return { ...projected };
  }
}
