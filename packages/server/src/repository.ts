import type {
  SnkSecret,
  ClpSecret,
  CliLoginId,
  CliLogin,
  SniSecret,
  JoinRoomRequest,
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
  /**
   * True when the Instance was admitted by an invite for an anonymous
   * Principal rather than registered with an API key. Its presence is renewed
   * by every authenticated request and its token never expires.
   */
  anonymous: boolean;
};

/**
 * Anything that can read, post, and wait inside a Room it belongs to. Since
 * decision 2026-09-06 every member is an Instance, so this is one type; the
 * alias stays because Room routes are written against it.
 */
export type RoomAuth = InstanceAuth;

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
  /**
   * Joins as the caller's own Principal. With `invite`, the seat is recorded
   * as admitted by that invite (which must open this Room and be usable) and
   * the invite's use is counted; without one, by Room id.
   */
  joinRoom(
    auth: InstanceAuth,
    roomId: RoomId,
    input?: JoinRoomRequest,
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
   * Admits an Agent that has only an invite: provisions an anonymous Principal
   * and an Instance under it, joins the Instance, and returns its token. Every
   * such join is a new member; a name is display text and never recovers an
   * identity. Returns the first page of history so one call is enough.
   */
  joinRoomWithInvite(
    token: string,
    roomId: RoomId,
    input: JoinRoomWithInviteRequest,
  ): Promise<{
    room: Room;
    membership: RoomMember;
    member_token: SniSecret;
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
  /**
   * Starts a CLI login. `seats` are Instance tokens this machine holds; each
   * that resolves to an active Instance of an anonymous Principal is recorded
   * for binding at approval. Returns the user code and poll token once.
   */
  startCliLogin(input: {
    label: string | null;
    seats: string[];
  }): Promise<{ login: CliLogin; user_code: string; poll_token: ClpSecret }>;
  /**
   * The Web approves a pending login as a Principal: binds every recorded
   * anonymous Principal into it (re-pointing their Instances; history follows)
   * and marks the login approved. The code is what the human saw.
   */
  approveCliLogin(input: {
    code: string;
    principalId: PrincipalId;
  }): Promise<{ login: CliLogin; bound_principal_ids: PrincipalId[] }>;
  /** What the approve page shows: the login behind a code, if it is still pending. */
  getCliLoginByCode(code: string): Promise<{ login: CliLogin } | null>;
  /**
   * The CLI polls with its token. Pending answers pending; approved mints an
   * API key for the approving Principal's account, marks the login consumed,
   * and returns the key exactly once.
   */
  pollCliLogin(
    loginId: CliLoginId,
    pollToken: string,
  ): Promise<
    | { state: "pending"; login: CliLogin }
    | {
        state: "approved";
        login: CliLogin;
        api_key: SnkSecret;
        api_key_id: ApiKeyId;
        principal: Principal;
      }
  >;
  executeIdempotent(
    scope: IdempotencyScope,
    fingerprint: string,
    operation: () => Promise<StoredHttpResult>,
  ): Promise<IdempotencyResult>;
}
