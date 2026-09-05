import type {
  InboxPosition,
  Agent,
  AgentId,
  ApiKeyId,
  CreateAgentRequest,
  Instance,
  InstanceId,
  InviteId,
  JoinRoomWithInviteRequest,
  MemberId,
  Message,
  MessageId,
  Page,
  Principal,
  PrincipalId,
  RitSecret,
  RmtSecret,
  Room,
  RoomId,
  RoomInvite,
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

/**
 * A Room member token identifies a guest: a member admitted by an invite, not
 * by an Instance. It is scoped to one Room and attributed to the Principal
 * whose invite admitted it.
 */
export type GuestAuth = {
  kind: "guest";
  principalId: PrincipalId;
  roomId: RoomId;
  memberId: MemberId;
  actorId: MemberId;
};

/** Anything that can read, post, and wait inside a Room it belongs to. */
export type RoomAuth = InstanceAuth | GuestAuth;

export type StoredHttpResult = {
  status: number;
  body: string;
};

export type IdempotencyScope = {
  principalId: PrincipalId;
  credentialClass: "api_key" | "instance" | "guest";
  actorId: ApiKeyId | InstanceId | MemberId;
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
  /** Resolves a Room member token; also records the guest as seen now. */
  authenticateGuest(token: string): Promise<GuestAuth | null>;
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
  /**
   * Mints an invite for a Room the Principal owns. The raw token is returned
   * once; only its digest is stored. `expiresInSeconds` null or 0 means never.
   */
  createRoomInvite(input: {
    roomId: RoomId;
    principalId: PrincipalId;
    expiresInSeconds?: number | null;
  }): Promise<{ invite: RoomInvite; token: RitSecret }>;
  revokeRoomInvite(input: {
    inviteId: InviteId;
    principalId: PrincipalId;
  }): Promise<{ invite: RoomInvite }>;
  /**
   * Admits a guest with an invite token. Every join creates a new member and a
   * new member token; a name is display text and never recovers an identity.
   * Returns the first page of history so one call is enough to catch up.
   */
  joinRoomWithInvite(
    token: string,
    roomId: RoomId,
    input: JoinRoomWithInviteRequest,
  ): Promise<{
    room: Room;
    membership: RoomMember;
    member_token: RmtSecret;
    history: Page<Message>;
  }>;
  getRoom(
    auth: RoomAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; memberships: RoomMember[] }>;
  postMessage(
    auth: RoomAuth,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null },
  ): Promise<{ message: Message }>;
  listMessages(
    auth: RoomAuth,
    roomId: RoomId,
    input: { after: number; limit: number },
  ): Promise<Page<Message>>;
  /**
   * Every message after the cursor across the Rooms the caller is an active
   * member of, oldest first. A guest sits in one Room; an Instance in many.
   * `next_cursor` is an opaque inbox cursor, never a sequence.
   */
  listInbox(
    auth: RoomAuth,
    input: { after: InboxPosition | null; limit: number },
  ): Promise<Page<Message>>;
  executeIdempotent(
    scope: IdempotencyScope,
    fingerprint: string,
    operation: () => Promise<StoredHttpResult>,
  ): Promise<IdempotencyResult>;
}
