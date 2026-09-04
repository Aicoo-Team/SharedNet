import type {
  Agent,
  AgentId,
  ApiKeyId,
  CreateAgentRequest,
  Instance,
  InstanceId,
  Message,
  MessageId,
  Principal,
  PrincipalId,
  Room,
  RoomId,
  RoomMember,
  StartInstanceRequest,
} from "../../protocol/src/index.ts";

export const PRESENCE_LEASE_MS = 90_000;
export const MAX_AGENTS_PER_PRINCIPAL = 100;
export const INSTANCE_TOKEN_TTL_MS = 86_400_000;
export const IDEMPOTENCY_RETENTION_MS = 86_400_000;

export type PrincipalAuth = {
  kind: "api_key";
  principalId: PrincipalId;
  actorId: ApiKeyId;
};

/**
 * An Instance token identifies an Instance and, through it, a Principal. It
 * deliberately does not carry the Instance's tag: the tag is a mutable pointer
 * that may change between requests, so anything that needs it reads the row.
 */
export type InstanceAuth = {
  kind: "instance";
  principalId: PrincipalId;
  instanceId: InstanceId;
  actorId: InstanceId;
};

export type StoredHttpResult = {
  status: number;
  body: string;
};

export type IdempotencyScope = {
  principalId: PrincipalId;
  credentialClass: "api_key" | "instance";
  actorId: ApiKeyId | InstanceId;
  operationId: string;
  key: string;
};

export type IdempotencyResult = StoredHttpResult & {
  replayed: boolean;
};

export class RepositoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RepositoryError";
    this.status = status;
    this.code = code;
  }
}

export interface SharedNetRepository {
  authenticateApiKey(token: string): Promise<PrincipalAuth | null>;
  authenticateInstance(token: string): Promise<InstanceAuth | null>;
  /** Idempotent by canonical handle: `created` is false when the tag existed. */
  createAgent(
    auth: PrincipalAuth,
    input: CreateAgentRequest,
  ): Promise<{ agent: Agent; created: boolean }>;
  listAgents(auth: PrincipalAuth): Promise<{ items: Agent[] }>;
  getAgent(auth: PrincipalAuth, agentId: AgentId): Promise<{ agent: Agent }>;
  /**
   * Registers the caller's session. When `local_instance_key` matches a live
   * Instance of this Principal the existing Instance is returned with a fresh
   * token and `created` is false; its tag and metadata are updated from the
   * request. Otherwise a new Instance is created.
   */
  startInstance(
    auth: PrincipalAuth,
    input: StartInstanceRequest,
  ): Promise<{
    instance: Instance;
    token: string;
    heartbeat_after_seconds: 30;
    created: boolean;
  }>;
  getCurrentInstance(auth: InstanceAuth): Promise<{
    principal: Principal;
    agent: Agent | null;
    instance: Instance;
  }>;
  heartbeat(
    auth: InstanceAuth,
  ): Promise<{ instance: Instance; heartbeat_after_seconds: 30 }>;
  createRoom(
    auth: InstanceAuth,
    input: { name: string; description?: string | null },
  ): Promise<{ room: Room; membership: RoomMember }>;
  joinRoom(
    auth: InstanceAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; membership: RoomMember }>;
  getRoom(
    auth: InstanceAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; memberships: RoomMember[] }>;
  postMessage(
    auth: InstanceAuth,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null },
  ): Promise<{ message: Message }>;
  listMessages(
    auth: InstanceAuth,
    roomId: RoomId,
    input: { after: number; limit: number },
  ): Promise<{ items: Message[]; next_cursor: string | null; has_more: boolean }>;
  executeIdempotent(
    scope: IdempotencyScope,
    fingerprint: string,
    operation: () => Promise<StoredHttpResult>,
  ): Promise<IdempotencyResult>;
}
