import type {
  SnkSecret,
  ClpSecret,
  CliLoginId,
  CliLogin,
  SniSecret,
  JoinRoomRequest,
  InboxPosition,
  AddRoomMembersRequest,
  Admission,
  InviteDescription,
  Agent,
  AgentId,
  ApiKeyId,
  CreateAgentRequest,
  CreateRoomRequest,
  Decision,
  DecisionId,
  DecisionStatus,
  ResolveDecisionRequest,
  UpdateInstanceRequest,
  Instance,
  InstanceId,
  InviteId,
  JoinRoomWithInviteRequest,
  MemberId,
  Message,
  MessageQuery,
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

/** A Room as the Dashboard lists it: the Room plus what the list shows beside it. */
export type RoomOverview = {
  room: Room;
  active_member_count: number;
  latest_sequence: number;
};

/** A Decision with who asked resolved through the requester Instance, since that may be another Principal. */
export type DecisionOverview = { decision: Decision; requested_by_principal_id: PrincipalId };

/** How a human answers a Decision addressed to their Principal. */
export type DecisionAnswer =
  | { outcome: "approved" | "denied" }
  | { outcome: "answered"; answer: string };

/** Two Instances share this many Rooms they are both active in. */
/**
 * Two Instances share `shared_rooms` Rooms. `strength` weights each of those
 * Rooms by its size, 1/(members - 1): a Room of two is a whole connection,
 * a Room of fifty is a sliver, so a crowded Room does not outweigh a pair
 * that actually work together.
 */
export type SharedRoomsEdge = { source_instance_id: InstanceId; target_instance_id: InstanceId; shared_rooms: number; strength: number };

/**
 * What a Principal can see of the network: its own Agents and Instances, and
 * every Principal, Agent and Instance that shares a Room with it, drawn
 * through the active seats of those Rooms. Nothing else is discoverable.
 */
export type NetworkView = {
  principal: Principal;
  agents: Agent[];
  instances: Instance[];
  connected_principals: Principal[];
  edges: SharedRoomsEdge[];
};

/**
 * One edge per pair of Instances active in the same Room; its weight is how
 * many Rooms they share. Shared by both repositories, so the Network reads
 * the same whichever one serves it.
 */
export function sharedRoomsEdges(roomsOfInstances: InstanceId[][]): SharedRoomsEdge[] {
  const edges = new Map<string, SharedRoomsEdge>();
  for (const instanceIds of roomsOfInstances) {
    const unique = [...new Set(instanceIds)].sort();
    const share = unique.length > 1 ? 1 / (unique.length - 1) : 0;
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const key = `${unique[i]}|${unique[j]}`;
        const existing = edges.get(key);
        if (existing) {
          existing.shared_rooms += 1;
          existing.strength += share;
        } else edges.set(key, { source_instance_id: unique[i]!, target_instance_id: unique[j]!, shared_rooms: 1, strength: share });
      }
    }
  }
  return [...edges.values()];
}

/** An Instance and the Rooms it sits in, for the CLI-login approve page. */
export type SeatOverview = { instance: Instance; rooms: Array<{ id: RoomId; name: string }> };

/**
 * The Dashboard's door: what a signed-in human's Principal may see and do.
 * Authorization lives here, in the one place the public API's rules also
 * live, so the two can never drift apart again: a Room is visible to the
 * Principal that scheduled it and to a Principal with an active seat in it;
 * everything else reads as absent.
 */
/** An MCP client that connected on a person's behalf: ChatGPT, Claude, or another. */
export type McpClient = { id: string; label: string };

/** The seat an MCP connection acts as: one Instance of the account's Principal per client. */
export type McpSeat = { principal: Principal; instance: Instance; auth: InstanceAuth; created: boolean };

export interface PrincipalRepository {
  /** The Principal behind an account, or null when none was provisioned. */
  principalForAccount(authUserId: string): Promise<Principal | null>;
  /**
   * The Instance an MCP client acts as for this account. The first call for a
   * client mints an API key for the account (named for the client, so the
   * person can see and revoke it) and registers an Instance whose local key
   * is the client id; later calls find the same Instance. No token leaves the
   * server: the connection acts through the returned InstanceAuth.
   */
  mcpSeat(authUserId: string, client: McpClient): Promise<McpSeat>;
  /** The cursor the service keeps for a seat with nowhere local to keep one; 0 when none yet. */
  getCursor(instanceId: InstanceId, roomId: RoomId): Promise<number>;
  setCursor(instanceId: InstanceId, roomId: RoomId, lastSequence: number): Promise<void>;
  /** Rooms the Principal scheduled or has an active seat in, newest first. */
  listRoomsForPrincipal(principalId: PrincipalId): Promise<{ items: RoomOverview[] }>;
  /** A Room the Principal may see, with every seat and every message, in order. */
  getRoomForPrincipal(
    principalId: PrincipalId,
    roomId: RoomId,
  ): Promise<{ room: Room; memberships: RoomMember[]; messages: Message[]; latest_sequence: number }>;
  /** Schedule an empty Room from the Web: no creator Instance, no members yet. */
  scheduleRoom(principalId: PrincipalId, input: { name: string; description: string | null }): Promise<{ room: Room }>;
  /** Close a Room the Principal owns; closing a closed Room returns it as it is. */
  closeRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room }>;
  /** Remove one seat from a Room the Principal owns; a seat that already left is returned as it is. */
  removeRoomMember(principalId: PrincipalId, roomId: RoomId, instanceId: InstanceId): Promise<{ membership: RoomMember }>;
  /** Decisions addressed to the Principal, newest first. */
  listDecisionsForPrincipal(principalId: PrincipalId): Promise<{ decisions: DecisionOverview[] }>;
  /**
   * The human answers a Decision addressed to their Principal. Approving a
   * request to seat one of their Instances writes the seat, the same way the
   * Instance's own answer through the API does; the Room must still be open.
   */
  resolveDecisionForPrincipal(
    principalId: PrincipalId,
    decisionId: DecisionId,
    answer: DecisionAnswer,
  ): Promise<{ decision: DecisionOverview; membership: RoomMember | null }>;
  networkForPrincipal(principalId: PrincipalId): Promise<NetworkView>;
  /** The named Instances with their Rooms; unknown ids are left out. */
  seatsOf(instanceIds: InstanceId[]): Promise<{ seats: SeatOverview[] }>;
}

export interface SharedNetRepository extends PrincipalRepository {
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
  /**
   * Opens a Room with the caller seated. Each Instance in `with` is seated at
   * once if public, asked through a Decision if private, or refused; the
   * caller's own Instances count as public.
   */
  createRoom(
    auth: InstanceAuth,
    input: CreateRoomRequest,
  ): Promise<{ room: Room; membership: RoomMember; admissions: Admission[] }>;
  /** What an invite token opens; 401 if unknown, 410 if revoked or expired. */
  describeInvite(token: string): Promise<InviteDescription>;
  /** The Rooms the calling Instance is an active member of, newest first. */
  listRooms(auth: InstanceAuth): Promise<{ items: Room[] }>;
  /** Grows a Room the way `with` formed it; any active member may ask. */
  addRoomMembers(
    auth: InstanceAuth,
    roomId: RoomId,
    input: AddRoomMembersRequest,
  ): Promise<{ admissions: Admission[] }>;
  /** What an Instance may change about itself; today, its reach. */
  updateInstance(auth: InstanceAuth, input: UpdateInstanceRequest): Promise<{ instance: Instance }>;
  /** Decisions addressed to the calling Instance, newest first. */
  listDecisions(auth: InstanceAuth, filter: { status?: DecisionStatus }): Promise<{ decisions: Decision[] }>;
  /**
   * The addressed Instance answers for itself. Approving a request to seat it
   * writes the membership and returns it.
   */
  resolveDecision(
    auth: InstanceAuth,
    decisionId: DecisionId,
    input: ResolveDecisionRequest,
  ): Promise<{ decision: Decision; membership: RoomMember | null }>;
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
  /** A window of a Room's log: filtered, ordered, cursored. See MessageQuery. */
  listMessages(auth: RoomAuth, roomId: RoomId, input: MessageQuery): Promise<Page<Message>>;
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
  /**
   * The signed-in Web mints a claim for its own account: a login that is
   * approved from the start, whose poll token is the claim code the join page
   * puts into the Agent's command. Single use; expires in seven days unused.
   */
  createCliClaim(input: { principalId: PrincipalId; label: string | null }): Promise<{ login: CliLogin; claim: ClpSecret }>;
  /** Redeems a claim by its code alone: the approved poll, found by the token's digest. */
  redeemCliClaim(claim: string): Promise<{
    state: "approved";
    login: CliLogin;
    api_key: SnkSecret;
    api_key_id: ApiKeyId;
    principal: Principal;
  }>;
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
