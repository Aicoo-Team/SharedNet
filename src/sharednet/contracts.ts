declare const sharedNetIdBrand: unique symbol;

type BrandedId<Name extends string> = string & {
  readonly [sharedNetIdBrand]: Name;
};

export type PrincipalId = BrandedId<"PrincipalId">;
export type AgentId = BrandedId<"AgentId">;
export type RuntimeId = BrandedId<"RuntimeId">;
export type InstanceId = BrandedId<"InstanceId">;
export type PairingId = BrandedId<"PairingId">;
export type RoomId = BrandedId<"RoomId">;
export type MessageId = BrandedId<"MessageId">;
export type DecisionId = BrandedId<"DecisionId">;
export type ArtifactId = BrandedId<"ArtifactId">;
export type OpaqueId = BrandedId<"OpaqueId">;
export type RoomCursor = BrandedId<"RoomCursor">;

export type ActorProjection = {
  agent_id: AgentId;
  instance_id?: InstanceId;
  principal_id: PrincipalId;
  runtime_id: RuntimeId;
};

export type PrincipalProjection = {
  created_at: string;
  diagnostic_label: string;
  kind: string;
  principal_id: PrincipalId;
  summary: string;
};

export type AgentProjection = {
  agent_id: AgentId;
  capabilities: string[];
  created_at: string;
  diagnostic_label: string;
  discoverability: boolean;
  official: boolean;
  principal_id: PrincipalId;
  role: string;
  runtime_kind: string;
  summary: string;
};

export type RuntimeProjection = {
  agent_id: AgentId;
  created_at: string;
  principal_id: PrincipalId;
  runtime_id: RuntimeId;
  runtime_kind: string;
  status: "active" | "revoked";
  workspace_label: string | null;
};

export type InstanceProjection = {
  agent_id: AgentId;
  ended_at: string | null;
  expires_at: string;
  instance_id: InstanceId;
  last_seen_at: string;
  presence: "online" | "offline";
  principal_id: PrincipalId;
  runtime_id: RuntimeId;
  runtime_type: string;
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

export type RoomMembership = {
  agent_id: AgentId;
  joined_at: string;
  last_read_sequence: number;
  left_at: string | null;
  principal_id: PrincipalId;
  room_id: RoomId;
  status: "active" | "left";
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
  sender: ActorProjection;
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

export type NetworkEdge = {
  kind: "principal_connection" | "room_co_membership";
  source_id: PrincipalId | AgentId;
  target_id: PrincipalId | AgentId;
  weight: number;
};

export type NetworkProjection = {
  agents: AgentProjection[];
  connected_principals: PrincipalProjection[];
  edges: NetworkEdge[];
  instances: InstanceProjection[];
  principal: PrincipalProjection;
  runtimes: RuntimeProjection[];
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
 * V1 public identifiers: a typed prefix plus 26 Crockford base32 characters,
 * exactly as `packages/protocol` issues them. `rt_` is the one exception: V1
 * has no Runtime entity, so the Dashboard derives a stable Runtime id per
 * (Agent, runtime kind) pair — see deriveRuntimeId in server-client.ts.
 */
const ULID_BODY = "[0-9a-hjkmnp-tv-z]{26}";
const PRINCIPAL_ID = new RegExp(`^pri_${ULID_BODY}$`);
const AGENT_ID = new RegExp(`^agt_${ULID_BODY}$`);
const RUNTIME_ID = new RegExp(`^rt_${ULID_BODY}$`);
const INSTANCE_ID = new RegExp(`^ins_${ULID_BODY}$`);
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

function isRuntimeId(value: unknown): value is RuntimeId {
  return isString(value) && RUNTIME_ID.test(value);
}

function isInstanceId(value: unknown): value is InstanceId {
  return isString(value) && INSTANCE_ID.test(value);
}

function isRoomCursor(value: unknown): value is RoomCursor {
  return isString(value) && CURSOR.test(value);
}

function isActorProjection(value: unknown): value is ActorProjection {
  const withInstance = hasExactKeys(value, [
    "principal_id",
    "agent_id",
    "runtime_id",
    "instance_id",
  ]);
  const withoutInstance = hasExactKeys(value, [
    "principal_id",
    "agent_id",
    "runtime_id",
  ]);
  if (!withInstance && !withoutInstance) return false;
  return (
    isPrincipalId(value.principal_id) &&
    isAgentId(value.agent_id) &&
    isRuntimeId(value.runtime_id) &&
    (!withInstance || isInstanceId(value.instance_id))
  );
}

function isInstanceActorProjection(
  value: unknown,
): value is Required<ActorProjection> {
  return (
    hasExactKeys(value, [
      "principal_id",
      "agent_id",
      "runtime_id",
      "instance_id",
    ]) &&
    isPrincipalId(value.principal_id) &&
    isAgentId(value.agent_id) &&
    isRuntimeId(value.runtime_id) &&
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
      "role",
      "summary",
      "runtime_kind",
      "capabilities",
      "discoverability",
      "official",
      "created_at",
    ]) &&
    isAgentId(value.agent_id) &&
    isPrincipalId(value.principal_id) &&
    isNonEmptyString(value.diagnostic_label) &&
    isNonEmptyString(value.role) &&
    isString(value.summary) &&
    isNonEmptyString(value.runtime_kind) &&
    isArrayOf(value.capabilities, isNonEmptyString) &&
    typeof value.discoverability === "boolean" &&
    typeof value.official === "boolean" &&
    isTimestamp(value.created_at)
  );
}

export function isRuntimeProjection(value: unknown): value is RuntimeProjection {
  return (
    hasExactKeys(value, [
      "runtime_id",
      "principal_id",
      "agent_id",
      "runtime_kind",
      "workspace_label",
      "status",
      "created_at",
    ]) &&
    isRuntimeId(value.runtime_id) &&
    isPrincipalId(value.principal_id) &&
    isAgentId(value.agent_id) &&
    isNonEmptyString(value.runtime_kind) &&
    isNullable(value.workspace_label, isNonEmptyString) &&
    (value.status === "active" || value.status === "revoked") &&
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
      "runtime_id",
      "runtime_type",
      "workspace_label",
      "status",
      "presence",
      "started_at",
      "last_seen_at",
      "expires_at",
      "ended_at",
    ]) &&
    isInstanceId(value.instance_id) &&
    isPrincipalId(value.principal_id) &&
    isAgentId(value.agent_id) &&
    isRuntimeId(value.runtime_id) &&
    isNonEmptyString(value.runtime_type) &&
    isNullable(value.workspace_label, isNonEmptyString) &&
    (value.status === "online" || value.status === "ended") &&
    (value.presence === "online" || value.presence === "offline") &&
    isTimestamp(value.started_at) &&
    isTimestamp(value.last_seen_at) &&
    isTimestamp(value.expires_at) &&
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

function isRoomMembership(value: unknown): value is RoomMembership {
  return (
    hasExactKeys(value, [
      "room_id",
      "principal_id",
      "agent_id",
      "status",
      "joined_at",
      "left_at",
      "last_read_sequence",
    ]) &&
    isIdentifier(value.room_id) &&
    isPrincipalId(value.principal_id) &&
    isAgentId(value.agent_id) &&
    (value.status === "active" || value.status === "left") &&
    isTimestamp(value.joined_at) &&
    isNullable(value.left_at, isTimestamp) &&
    isNonNegativeInteger(value.last_read_sequence)
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
    isActorProjection(value.sender) &&
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
  if (
    !hasExactKeys(value, ["kind", "source_id", "target_id", "weight"]) ||
    !isPositiveInteger(value.weight)
  ) {
    return false;
  }
  if (value.kind === "principal_connection") {
    return isPrincipalId(value.source_id) && isPrincipalId(value.target_id);
  }
  return (
    value.kind === "room_co_membership" &&
    isAgentId(value.source_id) &&
    isAgentId(value.target_id)
  );
}

export function isNetworkProjection(value: unknown): value is NetworkProjection {
  return (
    hasExactKeys(value, [
      "principal",
      "connected_principals",
      "agents",
      "runtimes",
      "instances",
      "edges",
    ]) &&
    isPrincipalProjection(value.principal) &&
    isArrayOf(value.connected_principals, isPrincipalProjection) &&
    isArrayOf(value.agents, isAgentProjection) &&
    isArrayOf(value.runtimes, isRuntimeProjection) &&
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
