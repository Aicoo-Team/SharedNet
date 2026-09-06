declare const sharedNetIdBrand: unique symbol;

type BrandedId<Name extends string> = string & {
  readonly [sharedNetIdBrand]: Name;
};

export type PrincipalId = BrandedId<"PrincipalId">;
export type AgentId = BrandedId<"AgentId">;
export type InstanceId = BrandedId<"InstanceId">;
export type PairingId = BrandedId<"PairingId">;
export type RoomId = BrandedId<"RoomId">;
export type MessageId = BrandedId<"MessageId">;
export type DecisionId = BrandedId<"DecisionId">;
export type ArtifactId = BrandedId<"ArtifactId">;
export type OpaqueId = BrandedId<"OpaqueId">;
export type RoomCursor = BrandedId<"RoomCursor">;

export type ActorProjection = {
  /** The actor's current tag, derived from its Instance; null when untagged. */
  agent_id: AgentId | null;
  instance_id?: InstanceId;
  principal_id: PrincipalId;
};

/**
 * Who said a Message. An Instance sender is an ActorProjection; a guest
 * sender has no Instance and carries the name it gave when it joined.
 */
export type MessageSender =
  | ActorProjection
  | { agent_id: null; name: string; principal_id: PrincipalId };

export type PrincipalProjection = {
  created_at: string;
  diagnostic_label: string;
  kind: string;
  principal_id: PrincipalId;
  summary: string;
};

/** A named tag over a Principal's Instances. It holds nothing and never acts. */
export type AgentProjection = {
  agent_id: AgentId;
  created_at: string;
  diagnostic_label: string;
  discoverability: boolean;
  handle: string;
  principal_id: PrincipalId;
  summary: string;
};

export type InstanceProjection = {
  /** Tag pointer; null renders under the synthetic "default" header. */
  agent_id: AgentId | null;
  ended_at: string | null;
  /** Null for an invite-admitted Instance: its seat lasts until removed. */
  expires_at: string | null;
  instance_id: InstanceId;
  last_seen_at: string;
  /**
   * Presence is lease-driven, so it answers "is something actively renewing
   * this?" rather than "did this ever exist". heartbeat_state names which of
   * those two the caller is looking at.
   */
  heartbeat_state: "renewing" | "never_started" | "stopped";
  presence: "online" | "offline";
  principal_id: PrincipalId;
  runtime_type: string;
  /** Runtime build, device id, workspace, OS — diagnostic, never authorization. */
  runtime_metadata: Record<string, string>;
  started_at: string;
  status: "online" | "ended";
  workspace_label: string | null;
};

export type RoomSummary = {
  description: string | null;
  latest_cursor: RoomCursor;
  latest_sequence: number;
  member_count: number;
  name: string;
  owner_agent_ids: AgentId[];
  room_id: RoomId;
  status: "open" | "closed";
  updated_at: string;
};

export type RoomProjection = {
  access_policy: "anyone_with_id" | "principal_only";
  created_at: string;
  creator: ActorProjection;
  description: string | null;
  name: string;
  room_id: RoomId;
  status: "open" | "closed";
  updated_at: string;
};

export type MemberPresence = "online" | "away" | "offline";

export type RoomMembership = {
  agent_id: AgentId | null;
  /** Every member is an Instance (decision 2026-09-06). */
  instance_id: InstanceId;
  joined_at: string;
  /**
   * What stands behind the member's Principal: `instance` for an account,
   * `guest` for an anonymous Principal provisioned by an invite join and not
   * yet bound to one.
   */
  kind: "instance" | "guest";
  last_read_sequence: number;
  left_at: string | null;
  /** The Instance id. */
  member_id: string;
  /** An invite-admitted Instance's self-declared name; null when its tag says who it is. */
  name: string | null;
  /** Derived on the server from the member's last authenticated request. */
  presence: MemberPresence;
  /** For a guest, the Principal whose invite admitted it. */
  principal_id: PrincipalId;
  room_id: RoomId;
  /** The driver behind the member's Instance: a handle, its version, and how that was learned. */
  runtime: RuntimeSummary;
  status: "active" | "left";
};

export type RuntimeSummary = {
  kind: string;
  version: string | null;
  entrypoint: string | null;
  source: "detected" | "declared" | null;
};

export type RoomInviteProjection = {
  created_at: string;
  expires_at: string | null;
  invite_id: string;
  revoked_at: string | null;
  room_id: RoomId;
  uses: number;
};

/** The raw invite token is returned once, here, and never stored. */
export type CreateRoomInviteResponse = {
  invite: RoomInviteProjection;
  token: string;
};

export type CoordinationTagProjection = {
  kind: "human_review" | "verification" | "delegation";
  raw: string;
  target_id: OpaqueId | null;
};

export type RoomMessage = {
  attachment_ids: ArtifactId[];
  content: string;
  created_at: string;
  message_id: MessageId;
  reply_to: MessageId | null;
  resolution_state: "not_required" | "pending" | "resolved" | "rejected";
  room_id: RoomId;
  sender: MessageSender;
  sequence: number;
  tags: CoordinationTagProjection[];
};

export type RoomDetail = {
  memberships: RoomMembership[];
  messages: RoomMessage[];
  next_cursor: RoomCursor;
  room: RoomProjection;
};

export type DecisionProjection = {
  consequence: string | null;
  created_at: string;
  decision_id: DecisionId;
  description: string;
  requester: Required<ActorProjection> | null;
  resolved_at: string | null;
  response_mode: "approval" | "text";
  response_text: string | null;
  room_id: RoomId | null;
  status: "pending" | "approved" | "denied" | "answered";
  target_principal_id: PrincipalId;
  title: string;
};

/**
 * One dot per Instance. `room_co_membership` is undirected and rendered dashed,
 * weighted by how many Rooms the two Instances share.
 *
 * `delegation` and `verification` are directed and are not emitted yet: nothing
 * in the schema records either. See the TODO in the V1 design spec.
 */
export type NetworkEdge = {
  kind: "room_co_membership" | "delegation" | "verification";
  source_id: InstanceId;
  target_id: InstanceId;
  weight: number;
};

export type NetworkProjection = {
  agents: AgentProjection[];
  connected_principals: PrincipalProjection[];
  edges: NetworkEdge[];
  instances: InstanceProjection[];
  principal: PrincipalProjection;
};

export type ProvisionAccountResponse = {
  principal_id: PrincipalId;
};

export type RoomListResponse = {
  rooms: RoomSummary[];
};

export type DecisionListResponse = {
  decisions: DecisionProjection[];
};

export type DecisionResolution = {
  outcome: "approved" | "denied" | "answered";
  responseText?: string;
};

type UnknownRecord = Record<string, unknown>;
type Predicate<T> = (value: unknown) => value is T;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Public identifiers, per design spec section 4.1: a type prefix plus ten
 * Base62 characters. There is no Runtime id — a Runtime is not addressable, so
 * where an Instance runs is metadata on the Instance rather than an entity.
 */
const PRINCIPAL_ID = /^p_[0-9A-Za-z]{10}$/;
const AGENT_ID = /^a_[0-9A-Za-z]{10}$/;
const INSTANCE_ID = /^i_[0-9A-Za-z]{10}$/;
const CURSOR = /^cursor_(?:0|[1-9][0-9]*)$/;

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isNullable<T>(value: unknown, predicate: Predicate<T>): value is T | null {
  return value === null || predicate(value);
}

function isArrayOf<T>(value: unknown, predicate: Predicate<T>): value is T[] {
  return Array.isArray(value) && value.every(predicate);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isIdentifier(value: unknown): value is OpaqueId {
  return isString(value) && IDENTIFIER.test(value);
}

function parseBrandedIdentifier<Id extends string>(value: unknown): Id | null {
  return isString(value) && IDENTIFIER.test(value) ? (value as Id) : null;
}

export function parsePairingId(value: unknown): PairingId | null {
  return parseBrandedIdentifier<PairingId>(value);
}

export function parseRoomId(value: unknown): RoomId | null {
  return parseBrandedIdentifier<RoomId>(value);
}

export function parseDecisionId(value: unknown): DecisionId | null {
  return parseBrandedIdentifier<DecisionId>(value);
}

function isPrincipalId(value: unknown): value is PrincipalId {
  return isString(value) && PRINCIPAL_ID.test(value);
}

function isAgentId(value: unknown): value is AgentId {
  return isString(value) && AGENT_ID.test(value);
}

function isInstanceId(value: unknown): value is InstanceId {
  return isString(value) && INSTANCE_ID.test(value);
}

function isRoomCursor(value: unknown): value is RoomCursor {
  return isString(value) && CURSOR.test(value);
}

function isActorProjection(value: unknown): value is ActorProjection {
  const withInstance = hasExactKeys(value, ["principal_id", "agent_id", "instance_id"]);
  const withoutInstance = hasExactKeys(value, ["principal_id", "agent_id"]);
  if (!withInstance && !withoutInstance) return false;
  return (
    isPrincipalId(value.principal_id) &&
    isNullable(value.agent_id, isAgentId) &&
    (!withInstance || isInstanceId(value.instance_id))
  );
}

function isMessageSender(value: unknown): value is MessageSender {
  if (isActorProjection(value)) return true;
  return (
    hasExactKeys(value, ["principal_id", "agent_id", "name"]) &&
    isPrincipalId(value.principal_id) &&
    value.agent_id === null &&
    isNonEmptyString(value.name)
  );
}

function isInstanceActorProjection(
  value: unknown,
): value is Required<ActorProjection> {
  return (
    hasExactKeys(value, ["principal_id", "agent_id", "instance_id"]) &&
    isPrincipalId(value.principal_id) &&
    isNullable(value.agent_id, isAgentId) &&
    isInstanceId(value.instance_id)
  );
}

export function isPrincipalProjection(
  value: unknown,
): value is PrincipalProjection {
  return (
    hasExactKeys(value, [
      "principal_id",
      "diagnostic_label",
      "kind",
      "summary",
      "created_at",
    ]) &&
    isPrincipalId(value.principal_id) &&
    isNonEmptyString(value.diagnostic_label) &&
    isNonEmptyString(value.kind) &&
    isString(value.summary) &&
    isTimestamp(value.created_at)
  );
}

export function isAgentProjection(value: unknown): value is AgentProjection {
  return (
    hasExactKeys(value, [
      "agent_id",
      "principal_id",
      "diagnostic_label",
      "handle",
      "summary",
      "discoverability",
      "created_at",
    ]) &&
    isAgentId(value.agent_id) &&
    isPrincipalId(value.principal_id) &&
    isNonEmptyString(value.diagnostic_label) &&
    isNonEmptyString(value.handle) &&
    isString(value.summary) &&
    typeof value.discoverability === "boolean" &&
    isTimestamp(value.created_at)
  );
}

export function isInstanceProjection(
  value: unknown,
): value is InstanceProjection {
  return (
    hasExactKeys(value, [
      "instance_id",
      "principal_id",
      "agent_id",
      "runtime_type",
      "runtime_metadata",
      "workspace_label",
      "status",
      "presence",
      "heartbeat_state",
      "started_at",
      "last_seen_at",
      "expires_at",
      "ended_at",
    ]) &&
    isInstanceId(value.instance_id) &&
    isPrincipalId(value.principal_id) &&
    isNullable(value.agent_id, isAgentId) &&
    isNonEmptyString(value.runtime_type) &&
    isStringRecord(value.runtime_metadata) &&
    isNullable(value.workspace_label, isNonEmptyString) &&
    (value.status === "online" || value.status === "ended") &&
    (value.presence === "online" || value.presence === "offline") &&
    (value.heartbeat_state === "renewing" ||
      value.heartbeat_state === "never_started" ||
      value.heartbeat_state === "stopped") &&
    isTimestamp(value.started_at) &&
    isTimestamp(value.last_seen_at) &&
    isNullable(value.expires_at, isTimestamp) &&
    isNullable(value.ended_at, isTimestamp)
  );
}

export function isRoomSummary(value: unknown): value is RoomSummary {
  return (
    hasExactKeys(value, [
      "room_id",
      "name",
      "description",
      "status",
      "updated_at",
      "latest_sequence",
      "latest_cursor",
      "member_count",
      "owner_agent_ids",
    ]) &&
    isIdentifier(value.room_id) &&
    isNonEmptyString(value.name) &&
    isNullable(value.description, isString) &&
    (value.status === "open" || value.status === "closed") &&
    isTimestamp(value.updated_at) &&
    isNonNegativeInteger(value.latest_sequence) &&
    isRoomCursor(value.latest_cursor) &&
    isNonNegativeInteger(value.member_count) &&
    isArrayOf(value.owner_agent_ids, isAgentId)
  );
}

function isRoomProjection(value: unknown): value is RoomProjection {
  return (
    hasExactKeys(value, [
      "room_id",
      "name",
      "description",
      "creator",
      "access_policy",
      "status",
      "created_at",
      "updated_at",
    ]) &&
    isIdentifier(value.room_id) &&
    isNonEmptyString(value.name) &&
    isNullable(value.description, isString) &&
    isActorProjection(value.creator) &&
    (value.access_policy === "anyone_with_id" ||
      value.access_policy === "principal_only") &&
    (value.status === "open" || value.status === "closed") &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
  );
}

function isRuntimeSummary(value: unknown): value is RuntimeSummary {
  return (
    hasExactKeys(value, ["kind", "version", "entrypoint", "source"]) &&
    isNonEmptyString(value.kind) &&
    isNullable(value.version, isString) &&
    isNullable(value.entrypoint, isString) &&
    (value.source === null || value.source === "detected" || value.source === "declared")
  );
}

function isMemberPresence(value: unknown): value is MemberPresence {
  return value === "online" || value === "away" || value === "offline";
}

function isRoomMembership(value: unknown): value is RoomMembership {
  if (
    !hasExactKeys(value, [
      "room_id",
      "principal_id",
      "agent_id",
      "instance_id",
      "kind",
      "member_id",
      "name",
      "presence",
      "status",
      "joined_at",
      "left_at",
      "last_read_sequence",
      "runtime",
    ]) ||
    !isRuntimeSummary(value.runtime) ||
    !isIdentifier(value.room_id) ||
    !isPrincipalId(value.principal_id) ||
    !isNullable(value.agent_id, isAgentId) ||
    !isMemberPresence(value.presence) ||
    !isNonEmptyString(value.member_id) ||
    (value.status !== "active" && value.status !== "left") ||
    !isTimestamp(value.joined_at) ||
    !isNullable(value.left_at, isTimestamp) ||
    !isNonNegativeInteger(value.last_read_sequence)
  ) {
    return false;
  }
  if (!isInstanceId(value.instance_id)) return false;
  if (value.kind === "instance") return isNullable(value.name, isNonEmptyString);
  return value.kind === "guest" && isNonEmptyString(value.name);
}

/** A CLI login as the approve page sees it: no code, no token. */
export type CliLoginProjection = {
  login_id: string;
  state: "pending" | "approved" | "consumed" | "denied" | "expired";
  label: string | null;
  expires_at: string;
  approved_at: string | null;
  /** The anonymous seats approval would bind to this account. */
  seats: {
    instance_id: InstanceId;
    name: string | null;
    runtime_kind: string;
    rooms: { room_id: RoomId; name: string }[];
  }[];
};

export function isCliLoginProjection(value: unknown): value is CliLoginProjection {
  return (
    hasExactKeys(value, ["login_id", "state", "label", "expires_at", "approved_at", "seats"]) &&
    isNonEmptyString(value.login_id) &&
    (value.state === "pending" ||
      value.state === "approved" ||
      value.state === "consumed" ||
      value.state === "denied" ||
      value.state === "expired") &&
    isNullable(value.label, isString) &&
    isTimestamp(value.expires_at) &&
    isNullable(value.approved_at, isTimestamp) &&
    isArrayOf(
      value.seats,
      (seat): seat is CliLoginProjection["seats"][number] =>
        hasExactKeys(seat, ["instance_id", "name", "runtime_kind", "rooms"]) &&
        isInstanceId(seat.instance_id) &&
        isNullable(seat.name, isString) &&
        isNonEmptyString(seat.runtime_kind) &&
        isArrayOf(
          seat.rooms,
          (room): room is { room_id: RoomId; name: string } =>
            hasExactKeys(room, ["room_id", "name"]) && isIdentifier(room.room_id) && isNonEmptyString(room.name),
        ),
    )
  );
}

/** The Room after a human closed it from the Web. */
export type CloseRoomResponse = { room: RoomProjection };

/** The membership after a human removed the member from the Web. */
export type RemoveRoomMemberResponse = { membership: RoomMembership };

export function isCloseRoomResponse(value: unknown): value is CloseRoomResponse {
  return hasExactKeys(value, ["room"]) && isRoomProjection(value.room);
}

export function isRemoveRoomMemberResponse(value: unknown): value is RemoveRoomMemberResponse {
  return hasExactKeys(value, ["membership"]) && isRoomMembership(value.membership);
}

export function isCreateRoomInviteResponse(value: unknown): value is CreateRoomInviteResponse {
  if (!hasExactKeys(value, ["invite", "token"]) || !isNonEmptyString(value.token)) {
    return false;
  }
  const invite = value.invite;
  return (
    hasExactKeys(invite, ["invite_id", "room_id", "expires_at", "revoked_at", "uses", "created_at"]) &&
    isNonEmptyString(invite.invite_id) &&
    isIdentifier(invite.room_id) &&
    isNullable(invite.expires_at, isTimestamp) &&
    isNullable(invite.revoked_at, isTimestamp) &&
    isNonNegativeInteger(invite.uses) &&
    isTimestamp(invite.created_at)
  );
}

function isCoordinationTagProjection(
  value: unknown,
): value is CoordinationTagProjection {
  if (
    !hasExactKeys(value, ["raw", "kind", "target_id"]) ||
    !isNonEmptyString(value.raw)
  ) {
    return false;
  }
  if (value.kind === "human_review") {
    return value.raw === "human-review-required" && value.target_id === null;
  }
  if (value.kind === "verification") {
    return value.raw === "verification-required" && value.target_id === null;
  }
  return (
    value.kind === "delegation" &&
    isIdentifier(value.target_id) &&
    value.raw === `delegate-to:${value.target_id}`
  );
}

export function isRoomMessage(value: unknown): value is RoomMessage {
  return (
    hasExactKeys(value, [
      "message_id",
      "room_id",
      "sequence",
      "sender",
      "content",
      "reply_to",
      "tags",
      "attachment_ids",
      "created_at",
      "resolution_state",
    ]) &&
    isIdentifier(value.message_id) &&
    isIdentifier(value.room_id) &&
    isPositiveInteger(value.sequence) &&
    isMessageSender(value.sender) &&
    isNonEmptyString(value.content) &&
    isNullable(value.reply_to, isIdentifier) &&
    isArrayOf(value.tags, isCoordinationTagProjection) &&
    isArrayOf(value.attachment_ids, isIdentifier) &&
    isTimestamp(value.created_at) &&
    (value.resolution_state === "not_required" ||
      value.resolution_state === "pending" ||
      value.resolution_state === "resolved" ||
      value.resolution_state === "rejected")
  );
}

export function isRoomDetail(value: unknown): value is RoomDetail {
  return (
    hasExactKeys(value, ["room", "memberships", "messages", "next_cursor"]) &&
    isRoomProjection(value.room) &&
    isArrayOf(value.memberships, isRoomMembership) &&
    isArrayOf(value.messages, isRoomMessage) &&
    isRoomCursor(value.next_cursor)
  );
}

export function isDecisionProjection(
  value: unknown,
): value is DecisionProjection {
  return (
    hasExactKeys(value, [
      "decision_id",
      "room_id",
      "target_principal_id",
      "requester",
      "response_mode",
      "title",
      "description",
      "consequence",
      "status",
      "response_text",
      "created_at",
      "resolved_at",
    ]) &&
    isIdentifier(value.decision_id) &&
    isNullable(value.room_id, isIdentifier) &&
    isPrincipalId(value.target_principal_id) &&
    isNullable(value.requester, isInstanceActorProjection) &&
    (value.response_mode === "approval" || value.response_mode === "text") &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.description) &&
    isNullable(value.consequence, isNonEmptyString) &&
    (value.status === "pending" ||
      value.status === "approved" ||
      value.status === "denied" ||
      value.status === "answered") &&
    isNullable(value.response_text, isNonEmptyString) &&
    isTimestamp(value.created_at) &&
    isNullable(value.resolved_at, isTimestamp)
  );
}

function isNetworkEdge(value: unknown): value is NetworkEdge {
  return (
    hasExactKeys(value, ["kind", "source_id", "target_id", "weight"]) &&
    isPositiveInteger(value.weight) &&
    (value.kind === "room_co_membership" ||
      value.kind === "delegation" ||
      value.kind === "verification") &&
    isInstanceId(value.source_id) &&
    isInstanceId(value.target_id)
  );
}

export function isNetworkProjection(value: unknown): value is NetworkProjection {
  return (
    hasExactKeys(value, [
      "principal",
      "connected_principals",
      "agents",
      "instances",
      "edges",
    ]) &&
    isPrincipalProjection(value.principal) &&
    isArrayOf(value.connected_principals, isPrincipalProjection) &&
    isArrayOf(value.agents, isAgentProjection) &&
    isArrayOf(value.instances, isInstanceProjection) &&
    isArrayOf(value.edges, isNetworkEdge)
  );
}

export function isProvisionAccountResponse(
  value: unknown,
): value is ProvisionAccountResponse {
  return hasExactKeys(value, ["principal_id"]) && isPrincipalId(value.principal_id);
}

export function isRoomListResponse(value: unknown): value is RoomListResponse {
  return hasExactKeys(value, ["rooms"]) && isArrayOf(value.rooms, isRoomSummary);
}

export function isDecisionListResponse(
  value: unknown,
): value is DecisionListResponse {
  return (
    hasExactKeys(value, ["decisions"]) &&
    isArrayOf(value.decisions, isDecisionProjection)
  );
}
