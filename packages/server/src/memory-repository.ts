import { timingSafeEqual } from "node:crypto";

import {
  type ClpSecret,
  type CliLoginId,
  type CliLogin,
  generateCliLoginCode,
  type RuntimeReport,
  type MemberRef,
  type MemberKind,
  type SniSecret,
  type JoinRoomRequest,
  type AdmittedBy,
  encodeInboxCursor,
  type InboxPosition,
  digestSecret,
  generatePublicId,
  generateSecret,
  type Agent,
  type AgentId,
  type ApiKeyId,
  type CreateAgentRequest,
  presenceFor,
  type Instance,
  type InstanceId,
  type InviteId,
  type JoinRoomWithInviteRequest,
  type MemberId,
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
import type {
  AddRoomMembersRequest,
  Admission,
  CreateRoomRequest,
  Decision,
  DecisionId,
  DecisionStatus,
  ResolveDecisionRequest,
  UpdateInstanceRequest,
} from "../../protocol/src/index.ts";
import {
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

type ApiKeyRecord = {
  id: ApiKeyId;
  principalId: PrincipalId;
  digest: string;
  revokedAt: string | null;
};

type InstanceRecord = Instance & {
  tokenDigest: string;
  /** Null for an invite-admitted Instance of an anonymous Principal. */
  issuedByKeyId: ApiKeyId | null;
  admittedByInviteId: InviteId | null;
  localInstanceKey: string | null;
};

// Records store who acted (an Instance id) and never a copy of its tag; the
// tag is read from the Instance at projection time so regrouping follows.
type RoomRecord = Omit<Room, "creator_agent_id"> & {
  nextSequence: number;
};
type MembershipRecord = {
  room_id: RoomId;
  instance_id: InstanceId;
  state: "active" | "left";
  joined_at: string;
  left_at: string | null;
  admitted_by: AdmittedBy;
  invite_id: InviteId | null;
  added_by_instance_id: InstanceId | null;
};
/** The requester's tag is read at projection time, like everywhere else. */
type DecisionRecord = Omit<Decision, "requested_by_agent_id">;
type InviteRecord = RoomInvite & { tokenDigest: string };
type MessageRecord = {
  id: MessageId;
  room_id: RoomId;
  sequence: number;
  sender_principal_id: PrincipalId;
  sender_instance_id: InstanceId;
  content: string;
  reply_to_message_id: MessageId | null;
  created_at: string;
};

type IdempotencyRecord = StoredHttpResult & {
  fingerprint: string;
};

type CliLoginRecord = CliLogin & {
  codeDigest: string;
  pollTokenDigest: string;
  apiKeyId: ApiKeyId | null;
};

const CLI_LOGIN_TTL_MS = 10 * 60_000;

export { RepositoryError } from "./repository.ts";
export type {
  IdempotencyResult,
  IdempotencyScope,
  InstanceAuth,
  PrincipalAuth,
  RoomAuth,
  SharedNetRepository,
} from "./repository.ts";

export type MemoryRepositoryOptions = {
  devApiKey?: string;
  /** Each key seeds its own Principal, for exercising cross-Principal paths. */
  devApiKeys?: string[];
  now?: () => Date;
};

function secureDigestEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** What an invite join recorded about the driver, as Instance metadata. */
function runtimeMetadataFromReport(runtime: RuntimeReport | undefined): Record<string, string> {
  if (!runtime) return {};
  const metadata: Record<string, string> = { runtime_source: runtime.source ?? "declared" };
  if (runtime.version) metadata.driver_version = runtime.version;
  if (runtime.entrypoint) metadata.entrypoint = runtime.entrypoint;
  return metadata;
}

/** The inbox order: time, then Room, then sequence. Total and stable. */
function compareInboxPosition(left: InboxPosition, right: InboxPosition): number {
  const byTime = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (byTime !== 0) return byTime;
  if (left.room_id !== right.room_id) return left.room_id < right.room_id ? -1 : 1;
  return left.sequence - right.sequence;
}

function membershipKey(roomId: RoomId, instanceId: InstanceId): string {
  return `${roomId}\0${instanceId}`;
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
  private readonly memberships = new Map<string, MembershipRecord>();
  private readonly decisions = new Map<DecisionId, DecisionRecord>();
  private readonly invites = new Map<InviteId, InviteRecord>();
  private readonly messages = new Map<RoomId, MessageRecord[]>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly cliLogins = new Map<CliLoginId, CliLoginRecord>();
  /** Anonymous Principals that were bound into an account's Principal. */
  private readonly mergedPrincipals = new Map<PrincipalId, PrincipalId>();
  private readonly idempotencyInFlight = new Map<
    string,
    { fingerprint: string; result: Promise<IdempotencyResult> }
  >();

  constructor(options: MemoryRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());

    const seedKeys = [
      ...(options.devApiKey ? [options.devApiKey] : []),
      ...(options.devApiKeys ?? []),
    ];
    for (const devApiKey of seedKeys) {
      const createdAt = this.timestamp();
      const principal: Principal = {
        id: generatePublicId("p"),
        display_name: null,
        default_reach: "public",
        created_at: createdAt,
        invited_by_principal_id: null,
      };
      const apiKeyRecord: ApiKeyRecord = {
        id: generatePublicId("key"),
        principalId: principal.id,
        digest: digestSecret(devApiKey),
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
    if (record.status === "ended" || record.status === "revoked") return null;
    // Any authenticated request is presence, for every Instance.
    const now = this.now();
    record.last_seen_at = now.toISOString();
    record.lease_expires_at = new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString();
    if (record.issuedByKeyId === null) {
      // An anonymous Principal's Instance: no key to check.
      return {
        kind: "instance",
        principalId: record.principal_id,
        instanceId: record.id,
        actorId: record.id,
        anonymous: true,
      };
    }
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
      instanceId: record.id,
      actorId: record.id,
      anonymous: false,
    };
  }

  async createAgent(
    auth: PrincipalAuth,
    input: CreateAgentRequest,
  ): Promise<{ agent: Agent; created: boolean }> {
    const owned = [...this.agents.values()].filter(
      (agent) => agent.principal_id === auth.principalId,
    );
    const existing = owned.find((agent) => agent.handle === input.handle);
    if (existing) return { agent: { ...existing }, created: false };
    if (owned.length >= MAX_AGENTS_PER_PRINCIPAL) {
      throw new RepositoryError(409, "agent_limit_reached", "Agent limit reached.");
    }
    const agent: Agent = {
      id: generatePublicId("a"),
      principal_id: auth.principalId,
      handle: input.handle,
      display_name: input.display_name ?? null,
      description: input.description ?? null,
      created_at: this.timestamp(),
    };
    this.agents.set(agent.id, agent);
    return { agent: { ...agent }, created: true };
  }

  async listAgents(auth: PrincipalAuth): Promise<{ items: Agent[] }> {
    const items = [...this.agents.values()]
      .filter((agent) => agent.principal_id === auth.principalId)
      .sort((a, b) => a.handle.localeCompare(b.handle) || a.id.localeCompare(b.id))
      .map((agent) => ({ ...agent }));
    return { items };
  }

  async getAgent(auth: PrincipalAuth, agentId: AgentId): Promise<{ agent: Agent }> {
    return { agent: { ...this.ownedAgent(auth, agentId) } };
  }

  async startInstance(
    auth: PrincipalAuth,
    input: StartInstanceRequest,
  ): Promise<{ instance: Instance; token: string; heartbeat_after_seconds: 30; created: boolean }> {
    if (input.agent_id) this.ownedAgent(auth, input.agent_id);

    const now = this.now();
    const token = generateSecret("sni");
    const tokenDigest = digestSecret(token);
    const leaseExpiresAt = new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString();

    // One session, one live Instance: a re-registration of the same runtime
    // session hands back the existing row with a fresh token.
    const existing = input.local_instance_key
      ? [...this.instances.values()].find(
          (candidate) =>
            candidate.principal_id === auth.principalId &&
            candidate.localInstanceKey === input.local_instance_key &&
            candidate.status !== "ended" &&
            candidate.status !== "revoked",
        )
      : undefined;
    if (existing) {
      this.instanceIdsByDigest.delete(existing.tokenDigest);
      existing.tokenDigest = tokenDigest;
      existing.issuedByKeyId = auth.actorId;
      existing.runtime_kind = input.runtime_kind;
      existing.cli_version = input.cli_version;
      if (input.agent_id !== undefined) existing.agent_id = input.agent_id;
      if (input.runtime_metadata !== undefined) existing.runtime_metadata = { ...input.runtime_metadata };
      existing.last_seen_at = now.toISOString();
      existing.lease_expires_at = leaseExpiresAt;
      existing.token_expires_at = null;
      existing.status = "online";
      if (input.reach !== undefined) existing.reach = input.reach;
      this.instanceIdsByDigest.set(tokenDigest, existing.id);
      return {
        instance: this.projectInstance(existing),
        token,
        heartbeat_after_seconds: 30,
        created: false,
      };
    }

    const instance: InstanceRecord = {
      id: generatePublicId("i"),
      principal_id: auth.principalId,
      agent_id: input.agent_id ?? null,
      runtime_kind: input.runtime_kind,
      cli_version: input.cli_version,
      runtime_metadata: { ...(input.runtime_metadata ?? {}) },
      status: "online",
      started_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      lease_expires_at: leaseExpiresAt,
      token_expires_at: null,
      ended_at: null,
      revoked_at: null,
      display_name: null,
      reach: input.reach ?? this.principals.get(auth.principalId)?.default_reach ?? "public",
      tokenDigest,
      issuedByKeyId: auth.actorId,
      admittedByInviteId: null,
      localInstanceKey: input.local_instance_key ?? null,
    };
    this.instances.set(instance.id, instance);
    this.instanceIdsByDigest.set(instance.tokenDigest, instance.id);
    return {
      instance: this.projectInstance(instance),
      token,
      heartbeat_after_seconds: 30,
      created: true,
    };
  }

  async getCurrentInstance(auth: InstanceAuth) {
    const record = this.instanceRecord(auth);
    const principal = this.principals.get(auth.principalId);
    if (!principal) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    const agent = record.agent_id ? this.agents.get(record.agent_id) : undefined;
    return {
      principal: { ...principal },
      agent: agent ? { ...agent } : null,
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
    input: CreateRoomRequest,
  ): Promise<{ room: Room; membership: RoomMember; admissions: Admission[] }> {
    const creator = this.requireOnline(auth);
    const createdAt = this.timestamp();
    const room: RoomRecord = {
      id: generatePublicId("rom"),
      principal_id: auth.principalId,
      name: input.name,
      description: input.description ?? null,
      state: "open",
      creator_instance_id: auth.instanceId,
      created_at: createdAt,
      closed_at: null,
      nextSequence: 1,
    };
    const membership: MembershipRecord = {
      room_id: room.id,
      instance_id: auth.instanceId,
      state: "active",
      joined_at: createdAt,
      left_at: null,
      admitted_by: "room_id",
      invite_id: null,
      added_by_instance_id: null,
    };
    this.rooms.set(room.id, room);
    this.memberships.set(membershipKey(room.id, auth.instanceId), membership);
    this.messages.set(room.id, []);
    const admissions = (input.with ?? []).map((instanceId) => this.admit(creator, room, instanceId));
    return { room: this.projectRoom(room), membership: this.projectMembership(membership), admissions };
  }

  async listRooms(auth: InstanceAuth): Promise<{ items: Room[] }> {
    this.instanceRecord(auth);
    const items = [...this.memberships.values()]
      .filter((membership) => membership.instance_id === auth.instanceId && membership.state === "active")
      .map((membership) => this.rooms.get(membership.room_id))
      .filter((room): room is RoomRecord => room !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((room) => this.projectRoom(room));
    return { items };
  }

  async addRoomMembers(
    auth: InstanceAuth,
    roomId: RoomId,
    input: AddRoomMembersRequest,
  ): Promise<{ admissions: Admission[] }> {
    const requester = this.requireOnline(auth);
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    return { admissions: input.with.map((instanceId) => this.admit(requester, room, instanceId)) };
  }

  async updateInstance(auth: InstanceAuth, input: UpdateInstanceRequest): Promise<{ instance: Instance }> {
    const record = this.instanceRecord(auth);
    if (input.reach !== undefined) record.reach = input.reach;
    return { instance: this.projectInstance(record) };
  }

  async listDecisions(
    auth: InstanceAuth,
    filter: { status?: DecisionStatus },
  ): Promise<{ decisions: Decision[] }> {
    this.instanceRecord(auth);
    const decisions = [...this.decisions.values()]
      .filter(
        (decision) =>
          decision.requested_for_instance_id === auth.instanceId &&
          (filter.status === undefined || decision.status === filter.status),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((decision) => this.projectDecision(decision));
    return { decisions };
  }

  async resolveDecision(
    auth: InstanceAuth,
    decisionId: DecisionId,
    input: ResolveDecisionRequest,
  ): Promise<{ decision: Decision; membership: RoomMember | null }> {
    this.instanceRecord(auth);
    const decision = this.decisions.get(decisionId);
    // A Decision that is not addressed to this Instance does not exist for it.
    if (!decision || decision.requested_for_instance_id !== auth.instanceId) {
      throw new RepositoryError(404, "decision_not_found", "Decision was not found.");
    }
    if (decision.status !== "pending") {
      throw new RepositoryError(409, "decision_already_resolved", "Decision was already resolved.");
    }
    let membership: MembershipRecord | null = null;
    if (input.resolution === "approved") {
      const room = decision.room_id ? this.rooms.get(decision.room_id) : undefined;
      if (!room || room.state === "closed") {
        throw new RepositoryError(409, "room_closed", "Room is closed.");
      }
      membership = this.seat(room, auth.instanceId, "accepted", decision.requested_by_instance_id);
    }
    decision.status = input.resolution;
    decision.resolved_at = this.timestamp();
    return {
      decision: this.projectDecision(decision),
      membership: membership ? this.projectMembership(membership) : null,
    };
  }

  /**
   * One Instance named in `with` (decision 2026-09-06 reach, §3): seated at
   * once when public or the requester's own, asked through a Decision when
   * private, refused otherwise. "refused" never says why, so ids cannot be
   * told apart by asking.
   */
  private admit(requester: InstanceRecord, room: RoomRecord, targetId: InstanceId): Admission {
    const refused: Admission = { instance_id: targetId, status: "refused", decision_id: null };
    const target = this.instances.get(targetId);
    if (!target || target.status === "ended" || target.status === "revoked") return refused;
    const existing = this.memberships.get(membershipKey(room.id, target.id));
    if (existing?.state === "active") return { instance_id: targetId, status: "member", decision_id: null };
    if (target.principal_id === requester.principal_id || target.reach === "public") {
      this.seat(room, target.id, "added", requester.id);
      return { instance_id: targetId, status: "member", decision_id: null };
    }
    const pending = [...this.decisions.values()].find(
      (decision) =>
        decision.room_id === room.id &&
        decision.requested_for_instance_id === target.id &&
        decision.status === "pending",
    );
    if (pending) return { instance_id: targetId, status: "pending", decision_id: pending.id };
    const decision: DecisionRecord = {
      id: generatePublicId("dec"),
      principal_id: target.principal_id,
      mode: "approval",
      title: `${requester.id} wants to add ${target.id} to Room "${room.name}"`,
      description: `Instance ${requester.id} of Principal ${requester.principal_id} asked to seat ${target.id} in Room ${room.id} ("${room.name}"). Approve to take the seat; deny to refuse.`,
      status: "pending",
      requested_by_instance_id: requester.id,
      requested_for_instance_id: target.id,
      room_id: room.id,
      answer: null,
      created_at: this.timestamp(),
      resolved_at: null,
    };
    this.decisions.set(decision.id, decision);
    return { instance_id: targetId, status: "pending", decision_id: decision.id };
  }

  /** Writes an active membership, reviving a left one. */
  private seat(
    room: RoomRecord,
    instanceId: InstanceId,
    admittedBy: "added" | "accepted",
    addedBy: InstanceId,
  ): MembershipRecord {
    const membership: MembershipRecord = {
      room_id: room.id,
      instance_id: instanceId,
      state: "active",
      joined_at: this.timestamp(),
      left_at: null,
      admitted_by: admittedBy,
      invite_id: null,
      added_by_instance_id: addedBy,
    };
    this.memberships.set(membershipKey(room.id, instanceId), membership);
    return membership;
  }

  private projectDecision(record: DecisionRecord): Decision {
    return { ...record, requested_by_agent_id: this.tagOf(record.requested_by_instance_id) };
  }

  async joinRoom(
    auth: InstanceAuth,
    roomId: RoomId,
    input: JoinRoomRequest = {},
  ): Promise<{ room: Room; membership: RoomMember }> {
    this.requireOnline(auth);
    const room = this.roomById(roomId);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    const invite = input.invite === undefined ? null : this.usableInvite(input.invite, room.id);
    const key = membershipKey(room.id, auth.instanceId);
    const existing = this.memberships.get(key);
    const membership: MembershipRecord =
      existing && existing.state === "active"
        ? existing
        : {
            room_id: room.id,
            instance_id: auth.instanceId,
            state: "active",
            joined_at: this.timestamp(),
            left_at: null,
            admitted_by: invite ? "invite" : "room_id",
            invite_id: invite?.id ?? null,
            added_by_instance_id: null,
          };
    if (membership !== existing) {
      this.memberships.set(key, membership);
      if (invite) invite.uses += 1;
    }
    return { room: this.projectRoom(room), membership: this.projectMembership(membership) };
  }

  /** The invite behind a token, if it opens this Room and is still usable. */
  private usableInvite(token: string, roomId: RoomId): InviteRecord {
    const candidate = digestSecret(token);
    let invite: InviteRecord | undefined;
    for (const record of this.invites.values()) {
      if (secureDigestEquals(candidate, record.tokenDigest)) {
        invite = record;
        break;
      }
    }
    // An invite is bound to one Room; presenting it on another is a bad credential.
    if (!invite || invite.room_id !== roomId) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    if (invite.revoked_at !== null) {
      throw new RepositoryError(410, "invite_revoked", "Room invite was revoked.");
    }
    if (invite.expires_at !== null && Date.parse(invite.expires_at) <= this.now().getTime()) {
      throw new RepositoryError(410, "invite_expired", "Room invite has expired.");
    }
    return invite;
  }

  async createRoomInvite(input: {
    roomId: RoomId;
    principalId: PrincipalId;
    expiresInSeconds?: number | null;
  }): Promise<{ invite: RoomInvite; token: RitSecret }> {
    const room = this.rooms.get(input.roomId);
    if (!room || room.principal_id !== input.principalId) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    const token = generateSecret("rit");
    const createdAt = this.now();
    const seconds = input.expiresInSeconds ?? 0;
    const invite: InviteRecord = {
      id: generatePublicId("inv"),
      room_id: room.id,
      principal_id: input.principalId,
      expires_at:
        seconds > 0 ? new Date(createdAt.getTime() + seconds * 1000).toISOString() : null,
      revoked_at: null,
      uses: 0,
      created_at: createdAt.toISOString(),
      tokenDigest: digestSecret(token),
    };
    this.invites.set(invite.id, invite);
    return { invite: this.projectInvite(invite), token };
  }

  async revokeRoomInvite(input: {
    inviteId: InviteId;
    principalId: PrincipalId;
  }): Promise<{ invite: RoomInvite }> {
    const invite = this.invites.get(input.inviteId);
    if (!invite || invite.principal_id !== input.principalId) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    invite.revoked_at ??= this.timestamp();
    return { invite: this.projectInvite(invite) };
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
    const invite = this.usableInvite(token, roomId);
    const room = this.roomById(invite.room_id);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    const now = this.now();
    const joinedAt = now.toISOString();
    // The Agent arrived with nothing but the invite: it gets a Principal of its
    // own, anonymous until someone binds it, and an Instance under it.
    const principal: Principal = {
      id: generatePublicId("p"),
      display_name: input.name,
      default_reach: "public",
      created_at: joinedAt,
      invited_by_principal_id: invite.principal_id,
    };
    const memberToken = generateSecret("sni");
    const runtime = input.runtime;
    const instance: InstanceRecord = {
      id: generatePublicId("i"),
      principal_id: principal.id,
      agent_id: null,
      runtime_kind: runtime?.kind ?? "custom",
      cli_version: runtime?.version ?? "invite",
      runtime_metadata: runtimeMetadataFromReport(runtime),
      status: "online",
      display_name: input.name,
      reach: input.reach ?? "public",
      started_at: joinedAt,
      last_seen_at: joinedAt,
      lease_expires_at: new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString(),
      token_expires_at: null,
      ended_at: null,
      revoked_at: null,
      tokenDigest: digestSecret(memberToken),
      issuedByKeyId: null,
      admittedByInviteId: invite.id,
      localInstanceKey: null,
    };
    const membership: MembershipRecord = {
      room_id: room.id,
      instance_id: instance.id,
      state: "active",
      joined_at: joinedAt,
      left_at: null,
      admitted_by: "invite",
      invite_id: invite.id,
      added_by_instance_id: null,
    };
    this.principals.set(principal.id, principal);
    this.instances.set(instance.id, instance);
    this.instanceIdsByDigest.set(instance.tokenDigest, instance.id);
    this.memberships.set(membershipKey(room.id, instance.id), membership);
    invite.uses += 1;
    const history = this.pageMessages(room.id, { after: 0, limit: 100 });
    return {
      room: this.projectRoom(room),
      membership: this.projectMembership(membership),
      member_token: memberToken,
      history,
    };
  }

  async getRoom(
    auth: RoomAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; memberships: RoomMember[] }> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    const memberships = [...this.memberships.values()]
      .filter((membership) => membership.room_id === room.id)
      .map((membership) => this.projectMembership(membership));
    return { room: this.projectRoom(room), memberships };
  }

  async postMessage(
    auth: RoomAuth,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null },
  ): Promise<{ message: Message }> {
    this.requireOnline(auth);
    const room = this.roomById(roomId);
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

    const message: MessageRecord = {
      id: generatePublicId("msg"),
      room_id: room.id,
      sequence: room.nextSequence,
      sender_principal_id: auth.principalId,
      sender_instance_id: auth.instanceId,
      content: input.content,
      reply_to_message_id: replyId,
      created_at: this.timestamp(),
    };
    room.nextSequence += 1;
    roomMessages.push(message);
    return { message: this.projectMessage(message) };
  }

  async listMessages(
    auth: RoomAuth,
    roomId: RoomId,
    input: { after: number; limit: number },
  ): Promise<Page<Message>> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    return this.pageMessages(room.id, input);
  }

  async listInbox(
    auth: RoomAuth,
    input: { after: InboxPosition | null; limit: number },
  ): Promise<Page<Message>> {
    const roomIds = [...this.memberships.values()]
      .filter((membership) => membership.instance_id === auth.instanceId && membership.state === "active")
      .map((membership) => membership.room_id);
    const after = input.after;
    const matching = roomIds
      .flatMap((roomId) => this.messages.get(roomId) ?? [])
      .filter((message) => after === null || compareInboxPosition(message, after) > 0)
      .sort(compareInboxPosition);
    const items = matching.slice(0, input.limit).map((message) => this.projectMessage(message));
    const last = items.at(-1);
    return {
      items,
      next_cursor: last
        ? encodeInboxCursor({ created_at: last.created_at, room_id: last.room_id, sequence: last.sequence })
        : after
          ? encodeInboxCursor(after)
          : null,
      has_more: matching.length > items.length,
    };
  }

  private pageMessages(roomId: RoomId, input: { after: number; limit: number }): Page<Message> {
    const matching = (this.messages.get(roomId) ?? []).filter(
      (message) => message.sequence > input.after,
    );
    const items = matching.slice(0, input.limit).map((message) => this.projectMessage(message));
    return {
      items,
      next_cursor:
        items.length > 0 ? String(items[items.length - 1]!.sequence) : input.after > 0 ? String(input.after) : null,
      has_more: matching.length > items.length,
    };
  }

  async startCliLogin(input: {
    label: string | null;
    seats: string[];
  }): Promise<{ login: CliLogin; user_code: string; poll_token: ClpSecret }> {
    const now = this.now();
    const bind: InstanceId[] = [];
    for (const seat of input.seats) {
      // Proof of possession: only a live seat of an anonymous Principal counts.
      const digest = digestSecret(seat);
      const instanceId = [...this.instanceIdsByDigest.entries()].find(([candidate]) =>
        secureDigestEquals(candidate, digest),
      )?.[1];
      const instance = instanceId ? this.instances.get(instanceId) : undefined;
      if (!instance || instance.issuedByKeyId !== null || instance.status === "ended" || instance.status === "revoked") continue;
      const principal = this.principals.get(instance.principal_id);
      if (!principal || principal.invited_by_principal_id === null || this.mergedPrincipals.has(principal.id)) continue;
      if (!bind.includes(instance.id)) bind.push(instance.id);
    }
    const code = generateCliLoginCode();
    const pollToken = generateSecret("clp");
    const record: CliLoginRecord = {
      id: generatePublicId("cli"),
      state: "pending",
      label: input.label,
      bind_instance_ids: bind,
      principal_id: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CLI_LOGIN_TTL_MS).toISOString(),
      approved_at: null,
      codeDigest: digestSecret(code),
      pollTokenDigest: digestSecret(pollToken),
      apiKeyId: null,
    };
    this.cliLogins.set(record.id, record);
    return { login: this.projectCliLogin(record), user_code: code, poll_token: pollToken };
  }

  private cliLoginByCode(code: string): CliLoginRecord | null {
    const digest = digestSecret(code);
    for (const record of this.cliLogins.values()) {
      if (secureDigestEquals(digest, record.codeDigest)) return record;
    }
    return null;
  }

  private expireCliLogin(record: CliLoginRecord): void {
    if (record.state === "pending" && Date.parse(record.expires_at) <= this.now().getTime()) {
      record.state = "expired";
    }
  }

  async getCliLoginByCode(code: string): Promise<{ login: CliLogin } | null> {
    const record = this.cliLoginByCode(code);
    if (!record) return null;
    this.expireCliLogin(record);
    return { login: this.projectCliLogin(record) };
  }

  async approveCliLogin(input: {
    code: string;
    principalId: PrincipalId;
  }): Promise<{ login: CliLogin; bound_principal_ids: PrincipalId[] }> {
    const record = this.cliLoginByCode(input.code);
    if (!record) throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    this.expireCliLogin(record);
    if (record.state === "expired") throw new RepositoryError(410, "login_expired", "CLI login has expired.");
    if (record.state === "denied") throw new RepositoryError(410, "login_denied", "CLI login was denied.");
    if (record.state !== "pending") throw new RepositoryError(410, "login_consumed", "CLI login was already used.");
    const account = this.principals.get(input.principalId);
    if (!account || account.invited_by_principal_id !== null) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    const bound: PrincipalId[] = [];
    for (const instanceId of record.bind_instance_ids) {
      const instance = this.instances.get(instanceId);
      if (!instance) continue;
      const anonymousId = instance.principal_id;
      if (anonymousId === account.id || this.mergedPrincipals.has(anonymousId)) continue;
      // Binding: every Instance of the anonymous Principal moves under the
      // account's Principal; memberships and messages follow the Instance.
      for (const candidate of this.instances.values()) {
        if (candidate.principal_id === anonymousId) candidate.principal_id = account.id;
      }
      for (const messages of this.messages.values()) {
        for (const message of messages) {
          if (message.sender_principal_id === anonymousId) message.sender_principal_id = account.id;
        }
      }
      this.mergedPrincipals.set(anonymousId, account.id);
      bound.push(anonymousId);
    }
    record.state = "approved";
    record.principal_id = account.id;
    record.approved_at = this.timestamp();
    return { login: this.projectCliLogin(record), bound_principal_ids: bound };
  }

  async pollCliLogin(loginId: CliLoginId, pollToken: string) {
    const record = this.cliLogins.get(loginId);
    if (!record || !secureDigestEquals(digestSecret(pollToken), record.pollTokenDigest)) {
      throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    }
    this.expireCliLogin(record);
    if (record.state === "expired") throw new RepositoryError(410, "login_expired", "CLI login has expired.");
    if (record.state === "denied") throw new RepositoryError(410, "login_denied", "CLI login was denied.");
    if (record.state === "consumed") throw new RepositoryError(410, "login_consumed", "CLI login was already used.");
    if (record.state === "pending") return { state: "pending" as const, login: this.projectCliLogin(record) };
    const principal = this.principals.get(record.principal_id!);
    if (!principal) throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    // The key is minted now, at the one moment it is handed over, so no raw key is ever stored.
    const apiKey = generateSecret("snk");
    const keyRecord: ApiKeyRecord = {
      id: generatePublicId("key"),
      principalId: principal.id,
      digest: digestSecret(apiKey),
      revokedAt: null,
    };
    this.apiKeysByDigest.set(keyRecord.digest, keyRecord);
    record.state = "consumed";
    record.apiKeyId = keyRecord.id;
    return {
      state: "approved" as const,
      login: this.projectCliLogin(record),
      api_key: apiKey,
      api_key_id: keyRecord.id,
      principal: { ...principal },
    };
  }

  private projectCliLogin(record: CliLoginRecord): CliLogin {
    const { codeDigest: _c, pollTokenDigest: _p, apiKeyId: _k, ...login } = record;
    return { ...login, bind_instance_ids: [...login.bind_instance_ids] };
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
      if (record.token_expires_at !== null && now >= Date.parse(record.token_expires_at)) status = "expired";
      else if (now >= Date.parse(record.lease_expires_at)) status = "offline";
      else status = "online";
    }
    const {
      tokenDigest: _tokenDigest,
      issuedByKeyId: _issuedByKeyId,
      admittedByInviteId: _admittedByInviteId,
      localInstanceKey: _localInstanceKey,
      ...projected
    } = record;
    return { ...projected, runtime_metadata: { ...projected.runtime_metadata }, status };
  }

  private instanceRecord(auth: InstanceAuth): InstanceRecord {
    const record = this.instances.get(auth.instanceId);
    if (!record || record.principal_id !== auth.principalId) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    return record;
  }

  private ownedAgent(auth: PrincipalAuth, agentId: AgentId): Agent {
    const agent = this.agents.get(agentId);
    if (!agent || agent.principal_id !== auth.principalId) {
      throw new RepositoryError(404, "agent_not_found", "Agent was not found.");
    }
    return agent;
  }

  /** The tag an Instance is currently under — read at projection time, never copied. */
  private tagOf(instanceId: InstanceId | null): AgentId | null {
    if (instanceId === null) return null;
    return this.instances.get(instanceId)?.agent_id ?? null;
  }

  /**
   * The kind of Principal behind an Instance: with an account, or anonymous.
   * It is the Principal that decides, not how the Instance was admitted: a
   * seat joined by invite reads as `instance` once its Principal is bound.
   */
  private memberKind(instance: InstanceRecord | undefined): MemberKind {
    const principal = instance ? this.principals.get(instance.principal_id) : undefined;
    return principal && principal.invited_by_principal_id !== null && !this.mergedPrincipals.has(principal.id)
      ? "guest"
      : "instance";
  }

  private memberRef(instanceId: InstanceId): MemberRef {
    const instance = this.instances.get(instanceId);
    return {
      member_id: instanceId,
      kind: this.memberKind(instance),
      name: instance?.display_name ?? null,
    };
  }

  private projectMembership(record: MembershipRecord): RoomMember {
    const instance = this.instances.get(record.instance_id);
    const principal = instance ? this.principals.get(instance.principal_id) : undefined;
    const lastSeenAt = instance?.last_seen_at ?? null;
    return {
      room_id: record.room_id,
      member_id: record.instance_id,
      kind: this.memberKind(instance),
      name: instance?.display_name ?? null,
      principal_id: instance?.principal_id ?? principal?.id ?? ("p_unknown" as PrincipalId),
      agent_id: this.tagOf(record.instance_id),
      instance_id: record.instance_id,
      invited_by_principal_id: principal?.invited_by_principal_id ?? null,
      admitted_by: record.admitted_by,
      invite_id: record.invite_id,
      added_by_instance_id: record.added_by_instance_id,
      runtime_kind: instance?.runtime_kind ?? "custom",
      runtime_version: instance?.cli_version ?? "",
      runtime_metadata: { ...(instance?.runtime_metadata ?? {}) },
      state: record.state,
      joined_at: record.joined_at,
      left_at: record.left_at,
      last_seen_at: lastSeenAt,
      presence: presenceFor(lastSeenAt, this.now()),
    };
  }

  private projectInvite(record: InviteRecord): RoomInvite {
    const { tokenDigest: _tokenDigest, ...invite } = record;
    return { ...invite };
  }

  private projectMessage(record: MessageRecord): Message {
    return {
      ...record,
      sender_agent_id: this.tagOf(record.sender_instance_id),
      sender: this.memberRef(record.sender_instance_id),
      type: "message",
    };
  }

  private requireOnline(auth: InstanceAuth): InstanceRecord {
    const record = this.instanceRecord(auth);
    if (this.projectInstance(record).status !== "online") {
      throw new RepositoryError(409, "instance_offline", "Instance is offline.");
    }
    return record;
  }

  /** A Room id is the capability; membership is checked separately. */
  private roomById(roomId: RoomId): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    return room;
  }

  private requireMembership(auth: RoomAuth, roomId: RoomId): void {
    const active = this.memberships.get(membershipKey(roomId, auth.instanceId))?.state === "active";
    if (!active) {
      throw new RepositoryError(
        403,
        "room_membership_required",
        "Active Room membership is required.",
      );
    }
  }

  private projectRoom(room: RoomRecord): Room {
    const { nextSequence: _nextSequence, ...projected } = room;
    return { ...projected, creator_agent_id: this.tagOf(room.creator_instance_id) };
  }
}
