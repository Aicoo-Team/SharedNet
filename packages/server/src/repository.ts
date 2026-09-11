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
  AfkSecret,
  ApiKeyId,
  Artifact,
  ArtifactId,
  ArtifactQuery,
  ArtifactReach,
  CreateAgentRequest,
  CreditBalance,
  CreditCode,
  CreditTransfer,
  CreditTransferRequest,
  TransferId,
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
  ShrSecret,
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

/**
 * Credits are the Principal's, so either credential reaches the purse: an
 * account key pays as the account, an Instance token pays as the account and
 * records which seat said so.
 */
export type CreditAuth = PrincipalAuth | InstanceAuth;

/**
 * Artifacts (decision 2026-09-11). An account holds files; a Room's members
 * read the ones handed to that Room. The same credential that speaks in a Room
 * uploads to it, so this takes the credit auth: either an account key or one
 * of its Instances, and the Instance is recorded as the uploader.
 */
export type UploadArtifactInput = {
  filename: string;
  content_type: string;
  reach: ArtifactReach;
  room_id: RoomId | null;
  bytes: Uint8Array;
};

/** The link is returned once, with the artifact, exactly like an invite token. */
export type UploadedArtifact = { artifact: Artifact; link_key: AfkSecret | null };

/** What one account is holding, against what it may hold. */
export type ArtifactUsage = { bytes: number; quota_bytes: number; count: number };

/** A page of the ledger, newest first; `before` is a transfer id to page past. */
export type CreditLedgerQuery = { limit: number; before: TransferId | null };

/** What redeeming answers: the purse, and how much this call added (0 when already redeemed). */
export type CreditRedemption = { credits: CreditBalance; granted: number; transfer: CreditTransfer | null };

/** The ledger as the Dashboard shows it: the purse and the latest transfers touching it. */
export type CreditsOverview = { credits: CreditBalance; transfers: CreditTransfer[] };

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

/** A Room as its owner or a seated Principal reads it; the link's slug only for the owner. */
export type RoomView = {
  room: Room;
  memberships: RoomMember[];
  messages: Message[];
  latest_sequence: number;
  share_token: ShrSecret | null;
};

/**
 * What a share link opens, for anyone: the Room, its seats, every message,
 * and the handle behind every tag a seat or a sender carries, so a reader
 * sees names rather than ids. The projection that leaves the server decides
 * what of this the public sees; the domain hands over the whole log.
 */
export type SharedRoomView = {
  room: Room;
  memberships: RoomMember[];
  messages: Message[];
  latest_sequence: number;
  agent_handles: Record<AgentId, string>;
};

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
  getRoomForPrincipal(principalId: PrincipalId, roomId: RoomId): Promise<RoomView>;
  /**
   * Publish a Room the Principal owns at a public, read-only link. Minting is
   * idempotent: a Room already published answers with the link it has, so the
   * owner can copy it again tomorrow; the link changes only when sharing stops
   * and starts anew. A closed Room can be published: a finished conversation
   * is the one most worth showing.
   */
  shareRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room; share_token: ShrSecret }>;
  /** Stop publishing; the link stops resolving at once. An unpublished Room is returned as it is. */
  unshareRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room }>;
  /**
   * The one door with nobody behind it: what a share link opens. An unknown,
   * malformed or revoked slug reads as absent, with no distinction, so slugs
   * cannot be probed.
   */
  getSharedRoom(shareToken: string): Promise<SharedRoomView>;
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
  /** The account's purse and the latest transfers touching it, newest first. */
  creditsForPrincipal(principalId: PrincipalId): Promise<CreditsOverview>;
  /** The human redeems a code on the Web; the same rules as through the API. */
  redeemCreditsForPrincipal(principalId: PrincipalId, code: string): Promise<CreditRedemption>;
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
  /** Exact message lookup within a Room; requires the caller's active membership. */
  getMessage(auth: RoomAuth, roomId: RoomId, messageId: MessageId): Promise<Message | null>;
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

  // ---- Credits (decision 2026-09-11): a purse per Principal, a ledger of every movement. ----

  /** The caller's purse: balance, and what was granted, sent and received in total. */
  getCredits(auth: CreditAuth): Promise<{ credits: CreditBalance }>;
  /**
   * Redeems a grant code for the caller's Principal, once. Only a Principal
   * with an account behind it may redeem (anonymous Principals are free to
   * create); a second redemption of the same code by the same Principal
   * answers with the purse unchanged and `granted: 0`, never an error, so a
   * retry is safe.
   */
  redeemCredits(auth: CreditAuth, code: string): Promise<CreditRedemption>;
  /**
   * Moves credits from the caller's purse to the purse behind `to`, which may
   * name a Principal, an Agent or an Instance. Final: no reversal exists.
   * 409 `insufficient_credits` when the purse cannot cover it, 404
   * `payee_not_found` for an id nobody holds, 422 `transfer_to_self`.
   */
  transferCredits(auth: CreditAuth, input: CreditTransferRequest): Promise<{ transfer: CreditTransfer; credits: CreditBalance }>;
  /** The ledger as it concerns the caller: transfers it sent or received, newest first. */
  listCreditTransfers(auth: CreditAuth, input: CreditLedgerQuery): Promise<Page<CreditTransfer>>;
  /**
   * The operator's door, with nobody behind it: mints a grant code. Reached
   * only by scripts/credits/mint-code.mjs with database access; no route.
   */
  mintCreditCode(input: { code: string; amount: number; max_redemptions?: number | null; expires_at?: string | null }): Promise<{ code: CreditCode }>;

  // ---- Artifacts (decision 2026-09-11): files an Agent hands to a Room. ----

  /**
   * Stores a file. `room` reach requires a Room the caller has an active seat
   * in — you hand a file to a Room you are in, not to one you merely know the
   * id of. `link` reach mints a key, returned once. Refuses a file over
   * `MAX_ARTIFACT_BYTES`, or one that would put the account over its quota.
   */
  uploadArtifact(auth: CreditAuth, input: UploadArtifactInput): Promise<UploadedArtifact>;
  /**
   * What a file is, without its bytes. Visible to the account that owns it and,
   * for `room` reach, to every Principal with an active seat in that Room.
   * Anything else reads as absent, so ids cannot be probed.
   */
  getArtifact(auth: CreditAuth, artifactId: ArtifactId): Promise<{ artifact: Artifact }>;
  /** The same rule, plus the bytes. */
  readArtifact(auth: CreditAuth, artifactId: ArtifactId): Promise<{ artifact: Artifact; bytes: Uint8Array }>;
  /**
   * The door with nobody behind it: a `link` artifact opened by its key. A
   * wrong key, a missing file, or a file whose reach is no longer `link` all
   * read as absent.
   */
  readArtifactByLink(artifactId: ArtifactId, key: string): Promise<{ artifact: Artifact; bytes: Uint8Array }>;
  /** Files the caller may read, newest first: its own, and its Rooms'. */
  listArtifacts(auth: CreditAuth, input: ArtifactQuery): Promise<Page<Artifact>>;
  /** How much the account is holding. */
  artifactUsage(auth: CreditAuth): Promise<ArtifactUsage>;
  /** Only the account that uploaded a file may remove it; removing it twice is a no-op. */
  deleteArtifact(auth: CreditAuth, artifactId: ArtifactId): Promise<{ artifact: Artifact }>;
}
