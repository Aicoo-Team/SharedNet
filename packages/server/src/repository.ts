import type {
  Agent,
  AgentId,
  ApiKeyId,
  Instance,
  InstanceId,
  Message,
  MessageId,
  Principal,
  PrincipalId,
  Room,
  RoomId,
  RoomMember,
} from "../../protocol/src/index.ts";

export const PRESENCE_LEASE_MS = 90_000;
export const INSTANCE_TOKEN_TTL_MS = 86_400_000;
export const IDEMPOTENCY_RETENTION_MS = 86_400_000;

export type PrincipalAuth = {
  kind: "api_key";
  principalId: PrincipalId;
  actorId: ApiKeyId;
};

export type InstanceAuth = {
  kind: "instance";
  principalId: PrincipalId;
  agentId: AgentId;
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
  ensureDefaultAgent(auth: PrincipalAuth): Promise<Agent>;
  startInstance(
    auth: PrincipalAuth,
    agentId: AgentId,
    input: { runtime_kind: Instance["runtime_kind"]; cli_version: string },
  ): Promise<{ instance: Instance; token: string; heartbeat_after_seconds: 30 }>;
  getCurrentInstance(auth: InstanceAuth): Promise<{
    principal: Principal;
    agent: Agent;
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
