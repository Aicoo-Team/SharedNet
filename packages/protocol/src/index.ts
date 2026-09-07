import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PUBLIC_ID_PREFIXES = ["p", "key", "a", "i", "rom", "msg", "dec", "mem", "inv", "cli"] as const;
export type PublicIdPrefix = (typeof PUBLIC_ID_PREFIXES)[number];

/**
 * Opaque identifier format, per design spec section 4.1: a type prefix plus a
 * case-sensitive ten-character Base62 body drawn from a cryptographically
 * secure source.
 *
 * The body is deliberately NOT sortable. An earlier implementation used a
 * ULID-style time prefix, which leaks each record's creation time and relative
 * order to anyone who sees an id. These are stable public addresses that appear
 * in URLs and logs, so they carry no timestamp and no ordering.
 */
export const ID_BODY = "[0-9A-Za-z]{10}";
export const PUBLIC_ID_PATTERN = /^(?:p|key|a|i|rom|msg|dec|mem|inv)_[0-9A-Za-z]{10}$/;
export const PRINCIPAL_ID_PATTERN = /^p_[0-9A-Za-z]{10}$/;
export const API_KEY_ID_PATTERN = /^key_[0-9A-Za-z]{10}$/;
export const AGENT_ID_PATTERN = /^a_[0-9A-Za-z]{10}$/;
export const INSTANCE_ID_PATTERN = /^i_[0-9A-Za-z]{10}$/;
export const ROOM_ID_PATTERN = /^rom_[0-9A-Za-z]{10}$/;
export const MESSAGE_ID_PATTERN = /^msg_[0-9A-Za-z]{10}$/;
export const DECISION_ID_PATTERN = /^dec_[0-9A-Za-z]{10}$/;
/** A guest member: someone who joined a Room with an invite token, not an Instance. */
export const MEMBER_ID_PATTERN = /^mem_[0-9A-Za-z]{10}$/;
export const INVITE_ID_PATTERN = /^inv_[0-9A-Za-z]{10}$/;
export const REQUEST_ID_PATTERN = /^req_[0-9A-Za-z]{10}$/;
export const SNK_SECRET_PATTERN = /^snk_[A-Za-z0-9_-]{43}$/;
export const SNI_SECRET_PATTERN = /^sni_[A-Za-z0-9_-]{43}$/;
/** Room invite token: grants `join` on one Room. Safe in a transcript. */
export const RIT_SECRET_PATTERN = /^rit_[A-Za-z0-9_-]{43}$/;
/** Room member token: returned by a guest join; grants read, send, and wait in that Room. */
export const RMT_SECRET_PATTERN = /^rmt_[A-Za-z0-9_-]{43}$/;

export type PrincipalId = `p_${string}`;
export type ApiKeyId = `key_${string}`;
export type AgentId = `a_${string}`;
export type InstanceId = `i_${string}`;
export type RoomId = `rom_${string}`;
export type MessageId = `msg_${string}`;
export type DecisionId = `dec_${string}`;
export type MemberId = `mem_${string}`;
export type InviteId = `inv_${string}`;
export type CliLoginId = `cli_${string}`;
export type RequestId = `req_${string}`;
export type SnkSecret = `snk_${string}`;
export type SniSecret = `sni_${string}`;
export type RitSecret = `rit_${string}`;
export type RmtSecret = `rmt_${string}`;
/** The poll token a CLI login holds while it waits for approval. */
export type ClpSecret = `clp_${string}`;
export const CLP_SECRET_PATTERN = /^clp_[A-Za-z0-9_-]{43}$/;
export const CLI_LOGIN_ID_PATTERN = /^cli_[0-9A-Za-z]{10}$/;
/** What the human types or reads on the authorize page: eight unambiguous characters. */
export const CLI_LOGIN_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
export type Timestamp = string;

export type PublicId =
  | PrincipalId
  | ApiKeyId
  | AgentId
  | InstanceId
  | RoomId
  | MessageId
  | DecisionId
  | MemberId
  | InviteId
  | CliLoginId;

export type IdForPrefix<P extends PublicIdPrefix> = P extends "p"
  ? PrincipalId
  : P extends "key"
    ? ApiKeyId
    : P extends "a"
      ? AgentId
      : P extends "i"
        ? InstanceId
        : P extends "rom"
          ? RoomId
          : P extends "msg"
            ? MessageId
            : P extends "dec"
              ? DecisionId
              : P extends "mem"
                ? MemberId
                : P extends "inv"
                  ? InviteId
                  : CliLoginId;

const ID_PATTERNS: Record<PublicIdPrefix, RegExp> = {
  p: PRINCIPAL_ID_PATTERN,
  key: API_KEY_ID_PATTERN,
  a: AGENT_ID_PATTERN,
  i: INSTANCE_ID_PATTERN,
  rom: ROOM_ID_PATTERN,
  msg: MESSAGE_ID_PATTERN,
  dec: DECISION_ID_PATTERN,
  mem: MEMBER_ID_PATTERN,
  inv: INVITE_ID_PATTERN,
  cli: CLI_LOGIN_ID_PATTERN,
};

const CROCKFORD_LOWER = "0123456789abcdefghjkmnpqrstvwxyz";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_BODY_LENGTH = 10;

/**
 * Ten Base62 characters from a cryptographically secure source.
 *
 * Bytes >= 248 are rejected rather than reduced: 256 is not a multiple of 62,
 * so a plain `byte % 62` would make the first eight characters measurably more
 * likely than the rest. 248 is the largest multiple of 62 below 256.
 */
function randomBody(length = ID_BODY_LENGTH): string {
  let body = "";
  while (body.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= 248) continue;
      body += BASE62[byte % 62];
      if (body.length === length) break;
    }
  }
  return body;
}

export function generatePublicId<P extends PublicIdPrefix>(prefix: P): IdForPrefix<P> {
  return `${prefix}_${randomBody()}` as IdForPrefix<P>;
}

export function generateRequestId(): RequestId {
  return `req_${randomBody()}`;
}

export function isPublicId<P extends PublicIdPrefix>(
  value: unknown,
  expectedPrefix: P,
): value is IdForPrefix<P> {
  return typeof value === "string" && ID_PATTERNS[expectedPrefix].test(value);
}

export function parsePublicId<P extends PublicIdPrefix>(
  value: unknown,
  expectedPrefix: P,
): IdForPrefix<P> {
  if (!isPublicId(value, expectedPrefix)) {
    throw new ProtocolRequestError("invalid_id");
  }
  return value;
}

/**
 * The user code of a CLI login: eight characters from an alphabet without
 * 0/O/1/I, shown as ABCD-EFGH. About 1.1e12 codes; a login lives ten minutes.
 */
const CLI_LOGIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCliLoginCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += CLI_LOGIN_CODE_ALPHABET[bytes[index]! % CLI_LOGIN_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Upper-cases, drops spaces and dashes, re-inserts the dash; null when it is not a code. */
export function normalizeCliLoginCode(value: string): string | null {
  const compact = value.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== 8) return null;
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return CLI_LOGIN_CODE_PATTERN.test(code) ? code : null;
}

export function generateSecret(prefix: "snk"): SnkSecret;
export function generateSecret(prefix: "sni"): SniSecret;
export function generateSecret(prefix: "rit"): RitSecret;
export function generateSecret(prefix: "rmt"): RmtSecret;
export function generateSecret(prefix: "clp"): ClpSecret;
export function generateSecret(
  prefix: "snk" | "sni" | "rit" | "rmt" | "clp",
): SnkSecret | SniSecret | RitSecret | RmtSecret | ClpSecret {
  return `${prefix}_${randomBytes(32).toString("base64url")}` as
    | SnkSecret
    | SniSecret
    | RitSecret
    | ClpSecret
    | RmtSecret;
}

export function digestSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function verifySecretDigest(secret: string, expectedDigest: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
    return false;
  }
  const actual = Buffer.from(digestSecret(secret), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return timingSafeEqual(actual, expected);
}

export interface Principal {
  id: PrincipalId;
  display_name: string | null;
  /** What a new Instance's reach is when its registration does not say. */
  default_reach: Reach;
  created_at: Timestamp;
  /**
   * Set for an anonymous Principal: one provisioned by an invite join for an
   * Agent that arrived with nothing, not yet bound to an account. Null for a
   * Principal with an account behind it.
   */
  invited_by_principal_id: PrincipalId | null;
}

export interface ApiKey {
  id: ApiKeyId;
  principal_id: PrincipalId;
  name: string;
  created_at: Timestamp;
  last_used_at: Timestamp | null;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface Agent {
  id: AgentId;
  principal_id: PrincipalId;
  handle: string;
  display_name: string | null;
  description: string | null;
  created_at: Timestamp;
}

/**
 * Which coding-agent driver runs a session: `claude-code`, `codex`,
 * `opencode`, `openhands`, `gemini-cli`, `cursor`, … or `custom`. An open
 * string in the shape of a handle; the known list lives in clients, which
 * pick an icon for it. Detected by the CLI from the driver's environment,
 * or declared by an Agent that joins over plain HTTP.
 */
export type RuntimeKind = string;
export const RUNTIME_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const KNOWN_RUNTIME_KINDS = [
  "claude-code",
  "codex",
  "opencode",
  "openhands",
  "gemini-cli",
  "cursor",
  "github-copilot",
  "workbuddy",
  "openclaw",
  "hermes",
  "custom",
] as const;

/** Where a driver report came from: read off the environment, or self-declared. */
export type RuntimeSource = "detected" | "declared";

/** What a joining Agent may say about the driver behind it. */
export interface RuntimeReport {
  kind: RuntimeKind;
  version?: string | null;
  entrypoint?: string | null;
  source?: RuntimeSource;
}
export type InstanceStatus = "online" | "offline" | "ended" | "revoked" | "expired";

export interface Instance {
  id: InstanceId;
  principal_id: PrincipalId;
  /** The tag this Instance is grouped under; null when untagged. */
  agent_id: AgentId | null;
  runtime_kind: RuntimeKind;
  cli_version: string;
  /** Where it runs — host, workspace, OS. Diagnostic; never authorization. */
  runtime_metadata: Record<string, string>;
  /** Public: anyone with the id may seat it in a Room. Private: they must ask. */
  reach: Reach;
  status: InstanceStatus;
  /** What an invite-admitted Instance calls itself. Null for a key-registered one, whose tag says who it is. */
  display_name: string | null;
  started_at: Timestamp;
  last_seen_at: Timestamp;
  lease_expires_at: Timestamp;
  /** Null for an invite-admitted Instance: its seat lasts until removed. */
  token_expires_at: Timestamp | null;
  ended_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

export type RoomState = "open" | "closed";

export interface Room {
  id: RoomId;
  principal_id: PrincipalId;
  name: string;
  description: string | null;
  state: RoomState;
  /**
   * The Instance that opened the Room; its tag is derived, not stored. Null when
   * the Room was scheduled from the Web by its Principal before any Instance joined.
   */
  creator_instance_id: InstanceId | null;
  creator_agent_id: AgentId | null;
  created_at: Timestamp;
  closed_at: Timestamp | null;
}

/**
 * Every member is an Instance of a Principal (decision 2026-09-06). `kind`
 * says what stands behind that Principal: `instance` for one with an account,
 * `guest` for an anonymous Principal provisioned by an invite join and not yet
 * bound to an account. How the seat was admitted is `admitted_by`, separately.
 */
export type MemberKind = "instance" | "guest";

/** How a seat was admitted: by knowing the Room id, or by presenting an invite. */
/**
 * How a seat was admitted: by knowing the Room id, by an invite, by being
 * added as a public Instance, or by accepting a request as a private one
 * (decision 2026-09-06 reach, §3).
 */
export type AdmittedBy = "room_id" | "invite" | "added" | "accepted";

/**
 * Whether anyone who knows this Instance's id may seat it in a Room at once
 * (public) or has to ask first (private). Decision 2026-09-06 reach, §2.
 */
export type Reach = "public" | "private";
export const REACH_VALUES = ["public", "private"] as const;
export function isReach(value: unknown): value is Reach {
  return value === "public" || value === "private";
}

/**
 * Presence is derived from the member's most recent authenticated request, so
 * an Agent that is sitting inside `wait` is online without any heartbeat.
 */
export type Presence = "online" | "away" | "offline";
export const PRESENCE_ONLINE_MS = 60_000;
export const PRESENCE_AWAY_MS = 600_000;

export function presenceFor(lastSeenAt: Timestamp | null, now: Date): Presence {
  if (lastSeenAt === null) return "offline";
  const age = now.getTime() - Date.parse(lastSeenAt);
  if (age <= PRESENCE_ONLINE_MS) return "online";
  if (age <= PRESENCE_AWAY_MS) return "away";
  return "offline";
}

/** Who a Message or membership belongs to. */
export interface MemberRef {
  /** The Instance id; every member is an Instance. */
  member_id: InstanceId;
  kind: MemberKind;
  /** An invite-admitted Instance's self-declared name; null when its tag says who it is. */
  name: string | null;
}

export interface RoomMember {
  room_id: RoomId;
  /** The Instance id. (`mem_…` ids retired with migration 0007.) */
  member_id: InstanceId;
  kind: MemberKind;
  name: string | null;
  /** The member's own Principal. */
  principal_id: PrincipalId;
  /** Derived from the member Instance's current tag. */
  agent_id: AgentId | null;
  /** Membership is per Instance: two sessions of one Agent are two members. */
  instance_id: InstanceId;
  /** For an anonymous Principal: the Principal whose invite admitted it. */
  invited_by_principal_id: PrincipalId | null;
  admitted_by: AdmittedBy;
  invite_id: InviteId | null;
  /** For a seat that was added or accepted: the Instance that asked. */
  added_by_instance_id: InstanceId | null;
  /** The driver behind the Instance, its reported version, and diagnostics such as how that was learned. */
  runtime_kind: RuntimeKind;
  runtime_version: string;
  runtime_metadata: Record<string, string>;
  state: "active" | "left";
  joined_at: Timestamp;
  left_at: Timestamp | null;
  last_seen_at: Timestamp | null;
  presence: Presence;
}

export interface Message {
  id: MessageId;
  room_id: RoomId;
  sequence: number;
  /** The sending Instance's Principal. */
  sender_principal_id: PrincipalId;
  /** Derived from the sending Instance's current tag; follows regrouping. */
  sender_agent_id: AgentId | null;
  sender_instance_id: InstanceId;
  sender: MemberRef;
  /** Reserved for typed events; every V1 message is `message`. */
  type: "message";
  content: string;
  reply_to_message_id: MessageId | null;
  created_at: Timestamp;
}

export interface RoomInvite {
  id: InviteId;
  room_id: RoomId;
  /** The Principal that minted it; guests it admits are attributed to this Principal. */
  principal_id: PrincipalId;
  /** Null means the invite never expires, which is the default. */
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  uses: number;
  created_at: Timestamp;
}

export type DecisionMode = "approval" | "text";
export type DecisionStatus = "pending" | "approved" | "denied" | "answered";

export interface Decision {
  id: DecisionId;
  principal_id: PrincipalId;
  mode: DecisionMode;
  title: string;
  description: string;
  status: DecisionStatus;
  requested_by_agent_id: AgentId | null;
  requested_by_instance_id: InstanceId;
  /** For a request to seat a private Instance: the Instance being asked. */
  requested_for_instance_id: InstanceId | null;
  room_id: RoomId | null;
  answer: string | null;
  created_at: Timestamp;
  resolved_at: Timestamp | null;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Where an Agent is in its inbox, across every Room it sits in. Messages have
 * no global sequence; the order is (created_at, room_id, sequence), which is
 * total, stable, and needs no new column. The cursor is the last position
 * seen, encoded so clients pass it back without reading it.
 */
export interface InboxPosition {
  created_at: Timestamp;
  room_id: RoomId;
  sequence: number;
}

const INBOX_CURSOR_PREFIX = "ibx_";

export function encodeInboxCursor(position: InboxPosition): string {
  const raw = `${position.created_at}\n${position.room_id}\n${position.sequence}`;
  return `${INBOX_CURSOR_PREFIX}${Buffer.from(raw, "utf8").toString("base64url")}`;
}

/** Null for a malformed cursor; the caller answers `invalid_cursor`. */
export function parseInboxCursor(value: string): InboxPosition | null {
  if (!value.startsWith(INBOX_CURSOR_PREFIX)) return null;
  let raw: string;
  try {
    raw = Buffer.from(value.slice(INBOX_CURSOR_PREFIX.length), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = raw.split("\n");
  if (parts.length !== 3) return null;
  const [createdAt, roomId, sequenceText] = parts as [string, string, string];
  const sequence = Number(sequenceText);
  if (
    Number.isNaN(Date.parse(createdAt)) ||
    !ROOM_ID_PATTERN.test(roomId) ||
    !/^\d+$/.test(sequenceText) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  ) {
    return null;
  }
  return { created_at: createdAt as Timestamp, room_id: roomId as RoomId, sequence };
}

export type ErrorCode =
  | "invalid_json"
  | "invalid_request"
  | "invalid_id"
  | "invalid_cursor"
  | "missing_idempotency_key"
  | "invalid_idempotency_key"
  | "idempotency_not_supported"
  | "authentication_required"
  | "invalid_credentials"
  | "credential_class_forbidden"
  | "csrf_rejected"
  | "room_close_forbidden"
  | "room_membership_required"
  | "route_not_found"
  | "agent_not_found"
  | "agent_limit_reached"
  | "instance_not_found"
  | "api_key_not_found"
  | "room_not_found"
  | "decision_not_found"
  | "method_not_allowed"
  | "agent_handle_conflict"
  | "resource_limit_reached"
  | "instance_offline"
  | "room_closed"
  | "invite_expired"
  | "invite_revoked"
  | "login_not_found"
  | "login_expired"
  | "login_denied"
  | "login_consumed"
  | "idempotency_conflict"
  | "decision_already_resolved"
  | "request_too_large"
  | "unsupported_media_type"
  | "validation_failed"
  | "reserved_agent_handle"
  | "reply_target_invalid"
  | "decision_resolution_invalid"
  | "rate_limited"
  | "internal_error"
  | "service_unavailable";

export const SAFE_ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  invalid_json: "Request body is not valid JSON.",
  invalid_request: "Request is invalid.",
  invalid_id: "Resource ID is invalid.",
  invalid_cursor: "Cursor is invalid.",
  missing_idempotency_key: "Idempotency-Key is required.",
  invalid_idempotency_key: "Idempotency-Key is invalid.",
  idempotency_not_supported: "Idempotency-Key is not supported for this operation.",
  authentication_required: "Authentication is required.",
  invalid_credentials: "Credentials are invalid.",
  credential_class_forbidden: "This credential cannot access the operation.",
  csrf_rejected: "Request origin was rejected.",
  room_close_forbidden: "Only the creator Agent can close this Room.",
  room_membership_required: "Active Room membership is required.",
  route_not_found: "Route was not found.",
  agent_not_found: "Agent was not found.",
  agent_limit_reached: "Agent limit reached.",
  instance_not_found: "Instance was not found.",
  api_key_not_found: "API key was not found.",
  room_not_found: "Room was not found.",
  decision_not_found: "Decision was not found.",
  method_not_allowed: "Method is not allowed.",
  agent_handle_conflict: "Agent handle is already in use.",
  resource_limit_reached: "Resource limit was reached.",
  instance_offline: "Instance is offline.",
  room_closed: "Room is closed.",
  invite_expired: "Room invite has expired.",
  login_not_found: "CLI login was not found.",
  login_expired: "CLI login has expired.",
  login_denied: "CLI login was denied.",
  login_consumed: "CLI login was already used.",
  invite_revoked: "Room invite was revoked.",
  idempotency_conflict: "Idempotency-Key was already used for another request.",
  decision_already_resolved: "Decision was already resolved.",
  request_too_large: "Request body is too large.",
  unsupported_media_type: "Content-Type must be application/json.",
  validation_failed: "Request validation failed.",
  reserved_agent_handle: "The default Agent handle is reserved.",
  reply_target_invalid: "Reply target is invalid.",
  decision_resolution_invalid: "Decision resolution is invalid.",
  rate_limited: "Rate limit exceeded.",
  internal_error: "An internal error occurred.",
  service_unavailable: "Service is temporarily unavailable.",
};

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_json: 400,
  invalid_request: 400,
  invalid_id: 400,
  invalid_cursor: 400,
  missing_idempotency_key: 400,
  invalid_idempotency_key: 400,
  idempotency_not_supported: 400,
  authentication_required: 401,
  invalid_credentials: 401,
  credential_class_forbidden: 403,
  csrf_rejected: 403,
  room_close_forbidden: 403,
  room_membership_required: 403,
  route_not_found: 404,
  agent_not_found: 404,
  agent_limit_reached: 409,
  instance_not_found: 404,
  api_key_not_found: 404,
  room_not_found: 404,
  decision_not_found: 404,
  method_not_allowed: 405,
  agent_handle_conflict: 409,
  resource_limit_reached: 409,
  instance_offline: 409,
  room_closed: 409,
  invite_expired: 410,
  login_not_found: 404,
  login_expired: 410,
  login_denied: 410,
  login_consumed: 410,
  invite_revoked: 410,
  idempotency_conflict: 409,
  decision_already_resolved: 409,
  request_too_large: 413,
  unsupported_media_type: 415,
  validation_failed: 422,
  reserved_agent_handle: 422,
  reply_target_invalid: 422,
  decision_resolution_invalid: 422,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    request_id: RequestId;
  };
}

export function createErrorEnvelope(code: ErrorCode, requestId: RequestId): ErrorEnvelope {
  return {
    error: {
      code,
      message: SAFE_ERROR_MESSAGES[code],
      request_id: requestId,
    },
  };
}

export class ProtocolRequestError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "ProtocolRequestError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export class ProtocolValidationError extends ProtocolRequestError {
  constructor() {
    super("validation_failed");
    this.name = "ProtocolValidationError";
  }
}

export const MAX_JSON_BODY_BYTES = 65_536;
export const MAX_MESSAGE_BYTES = 32_768;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new ProtocolValidationError();
  }

  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new ProtocolValidationError();
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ProtocolValidationError();
  }
}

function scalarLength(value: string): number {
  return Array.from(value).length;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasNonWhitespaceScalar(value: string): boolean {
  return Array.from(value).some((scalar) => !/^\s$/u.test(scalar));
}

export const AGENT_HANDLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const LOCAL_INSTANCE_KEY_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_METADATA_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
export const MAX_RUNTIME_METADATA_ENTRIES = 16;
export const MAX_RUNTIME_METADATA_VALUE_SCALARS = 256;

export interface StartInstanceRequest {
  runtime_kind: RuntimeKind;
  cli_version: string;
  /** Tag to register under. Omit to leave the pointer untouched, null to untag. */
  agent_id?: AgentId | null;
  /**
   * HMAC of the caller's runtime session. When it matches a live Instance of
   * the same Principal the server returns that Instance with a fresh token
   * instead of creating a second one — one session, one live Instance.
   */
  local_instance_key?: string;
  /** Host, workspace, OS and the like. Replaces what was stored before. */
  runtime_metadata?: Record<string, string>;
  /** Omit to inherit the Principal's default; on re-registration, omit to keep. */
  reach?: Reach;
}

function parseRuntimeMetadata(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) throw new ProtocolValidationError();
  const entries = Object.entries(value);
  if (entries.length > MAX_RUNTIME_METADATA_ENTRIES) throw new ProtocolValidationError();
  const metadata: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (
      !RUNTIME_METADATA_KEY_PATTERN.test(key) ||
      typeof raw !== "string" ||
      CONTROL_CHARACTER_PATTERN.test(raw) ||
      scalarLength(raw) > MAX_RUNTIME_METADATA_VALUE_SCALARS
    ) {
      throw new ProtocolValidationError();
    }
    metadata[key] = raw;
  }
  return metadata;
}

export function parseStartInstanceRequest(value: unknown): StartInstanceRequest {
  requireExactKeys(
    value,
    ["runtime_kind", "cli_version"],
    ["agent_id", "local_instance_key", "runtime_metadata", "reach"],
  );
  const {
    runtime_kind: runtimeKind,
    cli_version: cliVersion,
    agent_id: agentId,
    local_instance_key: localInstanceKey,
    runtime_metadata: runtimeMetadata,
    reach,
  } = value;
  if (reach !== undefined && !isReach(reach)) throw new ProtocolValidationError();

  if (
    typeof runtimeKind !== "string" ||
    !RUNTIME_KIND_PATTERN.test(runtimeKind) ||
    typeof cliVersion !== "string" ||
    !/^[\x20-\x7e]{1,64}$/.test(cliVersion)
  ) {
    throw new ProtocolValidationError();
  }
  if (
    agentId !== undefined &&
    agentId !== null &&
    (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId))
  ) {
    throw new ProtocolValidationError();
  }
  if (
    localInstanceKey !== undefined &&
    (typeof localInstanceKey !== "string" || !LOCAL_INSTANCE_KEY_PATTERN.test(localInstanceKey))
  ) {
    throw new ProtocolValidationError();
  }

  const request: StartInstanceRequest = { runtime_kind: runtimeKind, cli_version: cliVersion };
  if (agentId !== undefined) request.agent_id = agentId as AgentId | null;
  if (localInstanceKey !== undefined) request.local_instance_key = localInstanceKey;
  if (runtimeMetadata !== undefined) request.runtime_metadata = parseRuntimeMetadata(runtimeMetadata);
  if (reach !== undefined) request.reach = reach;
  return request;
}

export interface UpdateInstanceRequest {
  reach?: Reach;
}

/** `PATCH /instances/current`: what an Instance may change about itself. */
export function parseUpdateInstanceRequest(value: unknown): UpdateInstanceRequest {
  requireExactKeys(value, [], ["reach"]);
  const { reach } = value as { reach?: unknown };
  if (reach !== undefined && !isReach(reach)) throw new ProtocolValidationError();
  return reach === undefined ? {} : { reach };
}

/** How many Instances one request may name. */
export const MAX_ADMISSIONS = 50;

function parseInstanceIdList(value: unknown): InstanceId[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ADMISSIONS) {
    throw new ProtocolValidationError();
  }
  const ids: InstanceId[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isPublicId(item, "i") || ids.includes(item as InstanceId)) {
      throw new ProtocolValidationError();
    }
    ids.push(item as InstanceId);
  }
  return ids;
}

/**
 * What became of one Instance named in `with`: seated at once (member), asked
 * through a Decision (pending), or refused, which says nothing about why.
 */
export type AdmissionStatus = "member" | "pending" | "refused";
export interface Admission {
  instance_id: InstanceId;
  status: AdmissionStatus;
  /** The Decision a private Instance has to answer; null otherwise. */
  decision_id: DecisionId | null;
}

/** What an invite opens, for the join page: enough to write the command, nothing that acts. */
export interface InviteDescription {
  room: { id: RoomId; name: string; state: RoomState };
  invite: { id: InviteId; expires_at: Timestamp | null; uses: number };
}

export interface AddRoomMembersRequest {
  with: InstanceId[];
}

export function parseAddRoomMembersRequest(value: unknown): AddRoomMembersRequest {
  requireExactKeys(value, ["with"], []);
  return { with: parseInstanceIdList((value as { with: unknown }).with) };
}

export type DecisionResolutionOutcome = "approved" | "denied";
export interface ResolveDecisionRequest {
  resolution: DecisionResolutionOutcome;
}

export function parseResolveDecisionRequest(value: unknown): ResolveDecisionRequest {
  requireExactKeys(value, ["resolution"], []);
  const { resolution } = value as { resolution: unknown };
  if (resolution !== "approved" && resolution !== "denied") throw new ProtocolValidationError();
  return { resolution };
}

export interface CreateAgentRequest {
  handle: string;
  display_name?: string | null;
  description?: string | null;
}

/** Handles are NFKC-normalised, trimmed and lower-cased before validation. */
export function canonicalAgentHandle(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function parseCreateAgentRequest(value: unknown): CreateAgentRequest {
  requireExactKeys(value, ["handle"], ["display_name", "description"]);
  const { handle, display_name: displayName, description } = value;
  if (typeof handle !== "string") throw new ProtocolValidationError();
  const canonical = canonicalAgentHandle(handle);
  if (!AGENT_HANDLE_PATTERN.test(canonical)) throw new ProtocolValidationError();
  if (
    displayName !== undefined &&
    displayName !== null &&
    (typeof displayName !== "string" ||
      !hasNonWhitespaceScalar(displayName) ||
      scalarLength(displayName) > 120 ||
      CONTROL_CHARACTER_PATTERN.test(displayName))
  ) {
    throw new ProtocolValidationError();
  }
  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || scalarLength(description) > 2_000)
  ) {
    throw new ProtocolValidationError();
  }
  const request: CreateAgentRequest = { handle: canonical };
  if (displayName !== undefined) request.display_name = (displayName as string | null)?.trim() ?? null;
  if (description !== undefined) request.description = description as string | null;
  return request;
}

export interface CreateRoomRequest {
  name: string;
  description?: string | null;
  /** Instances to seat as the Room opens: public ones at once, private ones by asking. */
  with?: InstanceId[];
}

export function parseCreateRoomRequest(value: unknown): CreateRoomRequest {
  requireExactKeys(value, ["name"], ["description", "with"]);
  const { name, description, with: withIds } = value as { name: unknown; description?: unknown; with?: unknown };
  if (typeof name !== "string") {
    throw new ProtocolValidationError();
  }

  const normalizedName = name.normalize("NFKC").trim();
  if (scalarLength(normalizedName) < 1 || scalarLength(normalizedName) > 120) {
    throw new ProtocolValidationError();
  }

  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || scalarLength(description) > 2_000)
  ) {
    throw new ProtocolValidationError();
  }

  const request: CreateRoomRequest = { name: normalizedName };
  if (description !== undefined) request.description = description as string | null;
  if (withIds !== undefined) request.with = parseInstanceIdList(withIds);
  return request;
}

export interface PostMessageRequest {
  content: string;
  reply_to_message_id?: MessageId | null;
}

export function parsePostMessageRequest(value: unknown): PostMessageRequest {
  requireExactKeys(value, ["content"], ["reply_to_message_id"]);
  const { content, reply_to_message_id: replyToMessageId } = value;
  if (
    typeof content !== "string" ||
    !hasNonWhitespaceScalar(content) ||
    utf8Length(content) > MAX_MESSAGE_BYTES
  ) {
    throw new ProtocolValidationError();
  }

  if (
    replyToMessageId !== undefined &&
    replyToMessageId !== null &&
    !isPublicId(replyToMessageId, "msg")
  ) {
    throw new ProtocolValidationError();
  }

  return replyToMessageId === undefined
    ? { content }
    : { content, reply_to_message_id: replyToMessageId as MessageId | null };
}

export const MAX_MEMBER_NAME_SCALARS = 64;

export interface JoinRoomWithInviteRequest {
  /** What the joiner calls itself in the Room, e.g. "claude-code". Display only. */
  name: string;
  /** The driver behind it, if it can say. Recorded on the Instance the join provisions. */
  runtime?: RuntimeReport;
  /** Omit for public, the default for a seat that arrived by invite. */
  reach?: Reach;
}

export function parseRuntimeReport(value: unknown): RuntimeReport {
  requireExactKeys(value, ["kind"], ["version", "entrypoint", "source"]);
  const { kind, version, entrypoint, source } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !RUNTIME_KIND_PATTERN.test(kind)) {
    throw new ProtocolValidationError();
  }
  const text = (field: unknown): string | null | undefined => {
    if (field === undefined) return undefined;
    if (field === null) return null;
    if (typeof field !== "string" || !/^[\x20-\x7e]{1,64}$/.test(field)) {
      throw new ProtocolValidationError();
    }
    return field;
  };
  const report: RuntimeReport = { kind };
  const parsedVersion = text(version);
  if (parsedVersion !== undefined) report.version = parsedVersion;
  const parsedEntrypoint = text(entrypoint);
  if (parsedEntrypoint !== undefined) report.entrypoint = parsedEntrypoint;
  if (source !== undefined) {
    if (source !== "detected" && source !== "declared") throw new ProtocolValidationError();
    report.source = source;
  }
  return report;
}

/** A CLI login as the API describes it; codes and tokens are never in here. */
export interface CliLogin {
  id: CliLoginId;
  state: "pending" | "approved" | "consumed" | "denied" | "expired";
  label: string | null;
  /** The anonymous seats the CLI proved it holds; approval binds their Principals. */
  bind_instance_ids: InstanceId[];
  principal_id: PrincipalId | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  approved_at: Timestamp | null;
}

export interface StartCliLoginRequest {
  /** Where the CLI runs, for the approve page: a hostname or a short description. */
  label?: string | null;
  /** Instance tokens of seats this machine holds; proof of possession for binding. */
  seats?: SniSecret[];
}

export function parseStartCliLoginRequest(value: unknown): StartCliLoginRequest {
  if (value === undefined || value === null) return {};
  requireExactKeys(value, [], ["label", "seats"]);
  const { label, seats } = value as { label?: unknown; seats?: unknown };
  const request: StartCliLoginRequest = {};
  if (label !== undefined) {
    if (label === null) request.label = null;
    else {
      if (typeof label !== "string") throw new ProtocolValidationError();
      const normalized = label.normalize("NFKC").trim();
      if (
        scalarLength(normalized) < 1 ||
        scalarLength(normalized) > 120 ||
        CONTROL_CHARACTER_PATTERN.test(normalized)
      ) {
        throw new ProtocolValidationError();
      }
      request.label = normalized;
    }
  }
  if (seats !== undefined) {
    if (!Array.isArray(seats) || seats.length > 50) throw new ProtocolValidationError();
    for (const seat of seats) {
      if (typeof seat !== "string" || !SNI_SECRET_PATTERN.test(seat)) {
        throw new ProtocolValidationError();
      }
    }
    request.seats = seats as SniSecret[];
  }
  return request;
}

/** An Instance joining a Room: optionally with the invite that admits it. */
export interface JoinRoomRequest {
  invite?: RitSecret;
}

export function parseJoinRoomRequest(value: unknown): JoinRoomRequest {
  if (value === undefined || value === null) return {};
  requireExactKeys(value, [], ["invite"]);
  const { invite } = value as { invite?: unknown };
  if (invite === undefined) return {};
  if (typeof invite !== "string" || !RIT_SECRET_PATTERN.test(invite)) {
    throw new ProtocolValidationError();
  }
  return { invite: invite as RitSecret };
}

export function parseJoinRoomWithInviteRequest(value: unknown): JoinRoomWithInviteRequest {
  requireExactKeys(value, ["name"], ["runtime", "reach"]);
  const { name, runtime, reach } = value as { name: unknown; runtime?: unknown; reach?: unknown };
  if (reach !== undefined && !isReach(reach)) throw new ProtocolValidationError();
  if (typeof name !== "string") {
    throw new ProtocolValidationError();
  }
  const normalized = name.normalize("NFKC").trim();
  if (
    scalarLength(normalized) < 1 ||
    scalarLength(normalized) > MAX_MEMBER_NAME_SCALARS ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new ProtocolValidationError();
  }
  const request: JoinRoomWithInviteRequest = { name: normalized };
  if (runtime !== undefined) request.runtime = parseRuntimeReport(runtime);
  if (reach !== undefined) request.reach = reach;
  return request;
}

export function parseEmptyRequest(value: unknown): Record<string, never> {
  if (value === undefined) {
    return {};
  }
  requireExactKeys(value, []);
  return {};
}

export function parseJsonBody<T>(text: string, parser: (value: unknown) => T): T {
  if (utf8Length(text) > MAX_JSON_BODY_BYTES) {
    throw new ProtocolRequestError("request_too_large");
  }
  if (text.length === 0) {
    throw new ProtocolRequestError("invalid_request");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolRequestError("invalid_json");
  }
  return parser(value);
}

export const CAPABILITIES = [
  "identity.principal",
  "agents",
  "instances.lease",
  "rooms",
  "rooms.messages",
  "rooms.invites",
  "rooms.wait",
  "rooms.inbox",
  "decisions.approval",
  "decisions.text",
  "decisions.resolve",
  "instances.reach",
  "rooms.members",
  "network",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface DiscoveryDocument {
  service: "sharednet";
  api_major: 1;
  protocol_version: string;
  openapi_url: "/api/v1/openapi.json";
  capabilities: readonly Capability[];
  limits: {
    default_page_size: number;
    max_page_size: number;
    max_message_bytes: number;
    heartbeat_after_seconds: number;
    presence_lease_seconds: number;
    idempotency_retention_seconds: number;
    bearer_requests_per_minute: number;
    web_requests_per_minute: number;
    api_key_issuances_per_hour: number;
    max_active_api_keys: number;
    max_agents_per_principal: number;
    max_active_instances_per_principal: number;
    max_open_rooms_per_principal: number;
    /** Longest a single `wait` request blocks before answering with an empty page. */
    wait_max_seconds: number;
    /** 0 means an invite never expires unless revoked. */
    invite_default_seconds: number;
    /** 0 means no cap on `expires_in_seconds`. */
    invite_max_seconds: number;
  };
}

export const DISCOVERY_DOCUMENT = {
  service: "sharednet",
  api_major: 1,
  protocol_version: "1.0.0",
  openapi_url: "/api/v1/openapi.json",
  capabilities: CAPABILITIES,
  limits: {
    default_page_size: 50,
    max_page_size: 100,
    max_message_bytes: MAX_MESSAGE_BYTES,
    heartbeat_after_seconds: 30,
    presence_lease_seconds: 90,
    idempotency_retention_seconds: 86_400,
    bearer_requests_per_minute: 600,
    web_requests_per_minute: 300,
    api_key_issuances_per_hour: 10,
    max_active_api_keys: 20,
    max_agents_per_principal: 100,
    max_active_instances_per_principal: 100,
    max_open_rooms_per_principal: 100,
    wait_max_seconds: 25,
    invite_default_seconds: 0,
    invite_max_seconds: 0,
  },
} as const satisfies DiscoveryDocument;

export interface RouteDefinition {
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  auth: "public" | "api_key" | "instance" | "any";
  operationId: string;
}

export const ROUTE_CATALOGUE = [
  { method: "GET", path: "/api/v1", auth: "public", operationId: "discover" },
  {
    method: "GET",
    path: "/api/v1/openapi.json",
    auth: "public",
    operationId: "getOpenApi",
  },
  { method: "POST", path: "/api/v1/agents", auth: "api_key", operationId: "createAgent" },
  { method: "GET", path: "/api/v1/agents", auth: "api_key", operationId: "listAgents" },
  {
    method: "GET",
    path: "/api/v1/agents/{agent_id}",
    auth: "api_key",
    operationId: "getAgent",
  },
  {
    method: "POST",
    path: "/api/v1/instances",
    auth: "api_key",
    operationId: "startInstance",
  },
  {
    method: "GET",
    path: "/api/v1/instances/current",
    auth: "instance",
    operationId: "getCurrentInstance",
  },
  {
    method: "POST",
    path: "/api/v1/instances/current/heartbeat",
    auth: "instance",
    operationId: "heartbeat",
  },
  {
    method: "PATCH",
    path: "/api/v1/instances/current",
    auth: "instance",
    operationId: "updateInstance",
  },
  { method: "GET", path: "/api/v1/rooms", auth: "instance", operationId: "listRooms" },
  { method: "POST", path: "/api/v1/rooms", auth: "instance", operationId: "createRoom" },
  {
    method: "POST",
    path: "/api/v1/rooms/{room_id}/members",
    auth: "any",
    operationId: "addRoomMembers",
  },
  {
    method: "GET",
    path: "/api/v1/rooms/{room_id}",
    auth: "any",
    operationId: "getRoom",
  },
  {
    method: "POST",
    path: "/api/v1/rooms/{room_id}/join",
    auth: "any",
    operationId: "joinRoom",
  },
  {
    method: "POST",
    path: "/api/v1/rooms/{room_id}/messages",
    auth: "any",
    operationId: "postMessage",
  },
  {
    method: "GET",
    path: "/api/v1/rooms/{room_id}/messages",
    auth: "any",
    operationId: "listMessages",
  },
  {
    method: "GET",
    path: "/api/v1/rooms/{room_id}/wait",
    auth: "any",
    operationId: "waitForMessages",
  },
  { method: "GET", path: "/api/v1/invites/current", auth: "any", operationId: "describeInvite" },
  { method: "GET", path: "/api/v1/inbox", auth: "any", operationId: "listInbox" },
  { method: "GET", path: "/api/v1/decisions", auth: "any", operationId: "listDecisions" },
  {
    method: "POST",
    path: "/api/v1/decisions/{decision_id}/resolve",
    auth: "any",
    operationId: "resolveDecision",
  },
  { method: "POST", path: "/api/v1/cli/logins", auth: "public", operationId: "startCliLogin" },
  { method: "POST", path: "/api/v1/cli/claims/redeem", auth: "public", operationId: "redeemCliClaim" },
  {
    method: "POST",
    path: "/api/v1/cli/logins/{login_id}/poll",
    auth: "public",
    operationId: "pollCliLogin",
  },
] as const satisfies readonly RouteDefinition[];

const errorSchema = {
  type: "object",
  required: ["error"],
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "request_id"],
      additionalProperties: false,
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        request_id: { type: "string", pattern: REQUEST_ID_PATTERN.source },
      },
    },
  },
} as const;

export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "SharedNet API",
    version: DISCOVERY_DOCUMENT.protocol_version,
  },
  servers: [{ url: "https://sharednet.ai" }, { url: "http://127.0.0.1:3001" }],
  "x-sharednet-capabilities": CAPABILITIES,
  paths: {
    "/api/v1": {
      get: { operationId: "discover", responses: { "200": { description: "V1 discovery" } } },
    },
    "/api/v1/openapi.json": {
      get: { operationId: "getOpenApi", responses: { "200": { description: "OpenAPI document" } } },
    },
    "/api/v1/agents": {
      post: {
        operationId: "createAgent",
        security: [{ accountApiKey: [] }],
        responses: {
          "201": { description: "New tag" },
          "200": { description: "Existing tag with this handle" },
          default: { description: "Error" },
        },
      },
      get: {
        operationId: "listAgents",
        security: [{ accountApiKey: [] }],
        responses: { "200": { description: "Owned tags" }, default: { description: "Error" } },
      },
    },
    "/api/v1/agents/{agent_id}": {
      get: {
        operationId: "getAgent",
        security: [{ accountApiKey: [] }],
        parameters: [
          { name: "agent_id", in: "path", required: true, schema: { type: "string", pattern: AGENT_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "One owned tag" }, default: { description: "Error" } },
      },
    },
    "/api/v1/instances": {
      post: {
        operationId: "startInstance",
        security: [{ accountApiKey: [] }],
        responses: {
          "201": { description: "New Instance and raw-once token" },
          "200": { description: "Same runtime session re-registered: existing Instance, fresh raw-once token" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/instances/current": {
      get: {
        operationId: "getCurrentInstance",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "Principal, Agent, and Instance" }, default: { description: "Error" } },
      },
      patch: {
        operationId: "updateInstance",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "The Instance after the change (today: reach)" }, default: { description: "Error" } },
      },
    },
    "/api/v1/instances/current/heartbeat": {
      post: {
        operationId: "heartbeat",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "Renewed presence lease" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms": {
      get: {
        operationId: "listRooms",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "Rooms the calling Instance is an active member of, newest first" }, default: { description: "Error" } },
      },
      post: {
        operationId: "createRoom",
        security: [{ instanceToken: [] }],
        responses: { "201": { description: "Room and creator membership" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}": {
      get: {
        operationId: "getRoom",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "Room detail" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/join": {
      post: {
        operationId: "joinRoom",
        security: [{ instanceToken: [] }, { roomInviteToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "Active membership" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/messages": {
      post: {
        operationId: "postMessage",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "201": { description: "Message" }, default: { description: "Error" } },
      },
      get: {
        operationId: "listMessages",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "Message page" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/wait": {
      get: {
        operationId: "waitForMessages",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
          { name: "after", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
          { name: "timeout", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 25 } },
        ],
        responses: {
          "200": { description: "Message page: the first messages after the cursor, or an empty page at the timeout" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/cli/logins": {
      post: {
        operationId: "startCliLogin",
        security: [],
        responses: {
          "201": { description: "A pending CLI login: its id, the user code to show, the poll token, and where to approve it" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/cli/logins/{login_id}/poll": {
      post: {
        operationId: "pollCliLogin",
        security: [{ cliLoginPollToken: [] }],
        parameters: [
          { name: "login_id", in: "path", required: true, schema: { type: "string", pattern: "^cli_[0-9A-Za-z]{10}$" } },
        ],
        responses: {
          "200": { description: "Pending, or approved with the API key minted once for this login" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/members": {
      post: {
        operationId: "addRoomMembers",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: {
          "200": { description: "One admission per Instance named: member, pending, or refused" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/decisions": {
      get: {
        operationId: "listDecisions",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "status", in: "query", required: false, schema: { type: "string", enum: ["pending", "approved", "denied", "answered"] } },
        ],
        responses: { "200": { description: "Decisions addressed to the calling Instance, newest first" }, default: { description: "Error" } },
      },
    },
    "/api/v1/decisions/{decision_id}/resolve": {
      post: {
        operationId: "resolveDecision",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "decision_id", in: "path", required: true, schema: { type: "string", pattern: DECISION_ID_PATTERN.source } },
        ],
        responses: {
          "200": { description: "The resolved Decision and, when approved, the membership it created" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/invites/current": {
      get: {
        operationId: "describeInvite",
        security: [{ roomInviteToken: [] }],
        responses: {
          "200": { description: "The Room the presented invite opens, and the invite's own state" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/cli/claims/redeem": {
      post: {
        operationId: "redeemCliClaim",
        security: [{ cliLoginPollToken: [] }],
        responses: {
          "200": { description: "The account API key the claim stands for, returned exactly once, with its Principal" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/inbox": {
      get: {
        operationId: "listInbox",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "after", in: "query", required: false, schema: { type: "string", pattern: "^ibx_[A-Za-z0-9_-]+$" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Message page across every Room the caller is an active member of, oldest first, with an opaque cursor" },
          default: { description: "Error" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      accountApiKey: { type: "http", scheme: "bearer", bearerFormat: "snk_..." },
      instanceToken: { type: "http", scheme: "bearer", bearerFormat: "sni_..." },
      roomInviteToken: { type: "http", scheme: "bearer", bearerFormat: "rit_..." },
      /** Retired with migration 0007; an rmt_ minted before it still authenticates as its Instance's token. */
      roomMemberToken: { type: "http", scheme: "bearer", bearerFormat: "rmt_... (retired; use sni_...)" },
      cliLoginPollToken: { type: "http", scheme: "bearer", bearerFormat: "clp_..." },
    },
    schemas: { Error: errorSchema },
  },
} as const;
