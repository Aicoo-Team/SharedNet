import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PUBLIC_ID_PREFIXES = ["pri", "key", "agt", "ins", "rom", "msg", "dec"] as const;
export type PublicIdPrefix = (typeof PUBLIC_ID_PREFIXES)[number];

export const PUBLIC_ID_PATTERN = /^(?:pri|key|agt|ins|rom|msg|dec)_[0-9a-hjkmnp-tv-z]{26}$/;
export const PRINCIPAL_ID_PATTERN = /^pri_[0-9a-hjkmnp-tv-z]{26}$/;
export const API_KEY_ID_PATTERN = /^key_[0-9a-hjkmnp-tv-z]{26}$/;
export const AGENT_ID_PATTERN = /^agt_[0-9a-hjkmnp-tv-z]{26}$/;
export const INSTANCE_ID_PATTERN = /^ins_[0-9a-hjkmnp-tv-z]{26}$/;
export const ROOM_ID_PATTERN = /^rom_[0-9a-hjkmnp-tv-z]{26}$/;
export const MESSAGE_ID_PATTERN = /^msg_[0-9a-hjkmnp-tv-z]{26}$/;
export const DECISION_ID_PATTERN = /^dec_[0-9a-hjkmnp-tv-z]{26}$/;
export const REQUEST_ID_PATTERN = /^req_[0-9a-hjkmnp-tv-z]{26}$/;
export const SNK_SECRET_PATTERN = /^snk_[A-Za-z0-9_-]{43}$/;
export const SNI_SECRET_PATTERN = /^sni_[A-Za-z0-9_-]{43}$/;

export type PrincipalId = `pri_${string}`;
export type ApiKeyId = `key_${string}`;
export type AgentId = `agt_${string}`;
export type InstanceId = `ins_${string}`;
export type RoomId = `rom_${string}`;
export type MessageId = `msg_${string}`;
export type DecisionId = `dec_${string}`;
export type RequestId = `req_${string}`;
export type SnkSecret = `snk_${string}`;
export type SniSecret = `sni_${string}`;
export type Timestamp = string;

export type PublicId =
  | PrincipalId
  | ApiKeyId
  | AgentId
  | InstanceId
  | RoomId
  | MessageId
  | DecisionId;

export type IdForPrefix<P extends PublicIdPrefix> = P extends "pri"
  ? PrincipalId
  : P extends "key"
    ? ApiKeyId
    : P extends "agt"
      ? AgentId
      : P extends "ins"
        ? InstanceId
        : P extends "rom"
          ? RoomId
          : P extends "msg"
            ? MessageId
            : DecisionId;

const ID_PATTERNS: Record<PublicIdPrefix, RegExp> = {
  pri: PRINCIPAL_ID_PATTERN,
  key: API_KEY_ID_PATTERN,
  agt: AGENT_ID_PATTERN,
  ins: INSTANCE_ID_PATTERN,
  rom: ROOM_ID_PATTERN,
  msg: MESSAGE_ID_PATTERN,
  dec: DECISION_ID_PATTERN,
};

const CROCKFORD_LOWER = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeBase32(value: bigint, length: number): string {
  let output = "";
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    output = CROCKFORD_LOWER[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}

function sortableBody(now = Date.now()): string {
  const timestamp = encodeBase32(BigInt(now), 10);
  const random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  return `${timestamp}${encodeBase32(random, 16)}`;
}

export function generatePublicId<P extends PublicIdPrefix>(prefix: P): IdForPrefix<P> {
  return `${prefix}_${sortableBody()}` as IdForPrefix<P>;
}

export function generateRequestId(): RequestId {
  return `req_${sortableBody()}`;
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

export function generateSecret(prefix: "snk"): SnkSecret;
export function generateSecret(prefix: "sni"): SniSecret;
export function generateSecret(prefix: "snk" | "sni"): SnkSecret | SniSecret {
  return `${prefix}_${randomBytes(32).toString("base64url")}` as SnkSecret | SniSecret;
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
  created_at: Timestamp;
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
  is_default: boolean;
  created_at: Timestamp;
}

export type RuntimeKind = "codex" | "claude-code" | "custom";
export type InstanceStatus = "online" | "offline" | "ended" | "revoked" | "expired";

export interface Instance {
  id: InstanceId;
  principal_id: PrincipalId;
  agent_id: AgentId;
  runtime_kind: RuntimeKind;
  cli_version: string;
  status: InstanceStatus;
  started_at: Timestamp;
  last_seen_at: Timestamp;
  lease_expires_at: Timestamp;
  token_expires_at: Timestamp;
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
  creator_agent_id: AgentId;
  created_at: Timestamp;
  closed_at: Timestamp | null;
}

export interface RoomMember {
  room_id: RoomId;
  agent_id: AgentId;
  state: "active" | "left";
  joined_at: Timestamp;
  left_at: Timestamp | null;
}

export interface Message {
  id: MessageId;
  room_id: RoomId;
  sequence: number;
  sender_principal_id: PrincipalId;
  sender_agent_id: AgentId;
  sender_instance_id: InstanceId;
  content: string;
  reply_to_message_id: MessageId | null;
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
  requested_by_agent_id: AgentId;
  requested_by_instance_id: InstanceId;
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
  | "instance_not_found"
  | "api_key_not_found"
  | "room_not_found"
  | "decision_not_found"
  | "method_not_allowed"
  | "agent_handle_conflict"
  | "resource_limit_reached"
  | "instance_offline"
  | "room_closed"
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
  instance_not_found: "Instance was not found.",
  api_key_not_found: "API key was not found.",
  room_not_found: "Room was not found.",
  decision_not_found: "Decision was not found.",
  method_not_allowed: "Method is not allowed.",
  agent_handle_conflict: "Agent handle is already in use.",
  resource_limit_reached: "Resource limit was reached.",
  instance_offline: "Instance is offline.",
  room_closed: "Room is closed.",
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
  instance_not_found: 404,
  api_key_not_found: 404,
  room_not_found: 404,
  decision_not_found: 404,
  method_not_allowed: 405,
  agent_handle_conflict: 409,
  resource_limit_reached: 409,
  instance_offline: 409,
  room_closed: 409,
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

export interface StartInstanceRequest {
  runtime_kind: RuntimeKind;
  cli_version: string;
}

export function parseStartInstanceRequest(value: unknown): StartInstanceRequest {
  requireExactKeys(value, ["runtime_kind", "cli_version"]);
  const { runtime_kind: runtimeKind, cli_version: cliVersion } = value;

  if (
    (runtimeKind !== "codex" && runtimeKind !== "claude-code" && runtimeKind !== "custom") ||
    typeof cliVersion !== "string" ||
    !/^[\x20-\x7e]{1,64}$/.test(cliVersion)
  ) {
    throw new ProtocolValidationError();
  }

  return { runtime_kind: runtimeKind, cli_version: cliVersion };
}

export interface CreateRoomRequest {
  name: string;
  description?: string | null;
}

export function parseCreateRoomRequest(value: unknown): CreateRoomRequest {
  requireExactKeys(value, ["name"], ["description"]);
  const { name, description } = value;
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

  return description === undefined
    ? { name: normalizedName }
    : { name: normalizedName, description: description as string | null };
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
  "decisions.approval",
  "decisions.text",
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
    instance_token_ttl_seconds: number;
    idempotency_retention_seconds: number;
    bearer_requests_per_minute: number;
    web_requests_per_minute: number;
    api_key_issuances_per_hour: number;
    max_active_api_keys: number;
    max_agents_per_principal: number;
    max_active_instances_per_principal: number;
    max_open_rooms_per_principal: number;
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
    instance_token_ttl_seconds: 86_400,
    idempotency_retention_seconds: 86_400,
    bearer_requests_per_minute: 600,
    web_requests_per_minute: 300,
    api_key_issuances_per_hour: 10,
    max_active_api_keys: 20,
    max_agents_per_principal: 100,
    max_active_instances_per_principal: 100,
    max_open_rooms_per_principal: 100,
  },
} as const satisfies DiscoveryDocument;

export interface RouteDefinition {
  method: "GET" | "POST" | "PUT";
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
  {
    method: "PUT",
    path: "/api/v1/agents/default",
    auth: "api_key",
    operationId: "ensureDefaultAgent",
  },
  {
    method: "POST",
    path: "/api/v1/agents/{agent_id}/instances",
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
  { method: "POST", path: "/api/v1/rooms", auth: "instance", operationId: "createRoom" },
  {
    method: "GET",
    path: "/api/v1/rooms/{room_id}",
    auth: "instance",
    operationId: "getRoom",
  },
  {
    method: "POST",
    path: "/api/v1/rooms/{room_id}/join",
    auth: "instance",
    operationId: "joinRoom",
  },
  {
    method: "POST",
    path: "/api/v1/rooms/{room_id}/messages",
    auth: "instance",
    operationId: "postMessage",
  },
  {
    method: "GET",
    path: "/api/v1/rooms/{room_id}/messages",
    auth: "instance",
    operationId: "listMessages",
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
    "/api/v1/agents/default": {
      put: {
        operationId: "ensureDefaultAgent",
        security: [{ accountApiKey: [] }],
        responses: { "200": { description: "Default Agent" }, default: { description: "Error" } },
      },
    },
    "/api/v1/agents/{agent_id}/instances": {
      post: {
        operationId: "startInstance",
        security: [{ accountApiKey: [] }],
        parameters: [
          { name: "agent_id", in: "path", required: true, schema: { type: "string", pattern: AGENT_ID_PATTERN.source } },
        ],
        responses: { "201": { description: "Instance and raw-once token" }, default: { description: "Error" } },
      },
    },
    "/api/v1/instances/current": {
      get: {
        operationId: "getCurrentInstance",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "Principal, Agent, and Instance" }, default: { description: "Error" } },
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
      post: {
        operationId: "createRoom",
        security: [{ instanceToken: [] }],
        responses: { "201": { description: "Room and creator membership" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}": {
      get: {
        operationId: "getRoom",
        security: [{ instanceToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "Room detail" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/join": {
      post: {
        operationId: "joinRoom",
        security: [{ instanceToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "Active membership" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/messages": {
      post: {
        operationId: "postMessage",
        security: [{ instanceToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "201": { description: "Message" }, default: { description: "Error" } },
      },
      get: {
        operationId: "listMessages",
        security: [{ instanceToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "Message page" }, default: { description: "Error" } },
      },
    },
  },
  components: {
    securitySchemes: {
      accountApiKey: { type: "http", scheme: "bearer", bearerFormat: "snk_..." },
      instanceToken: { type: "http", scheme: "bearer", bearerFormat: "sni_..." },
    },
    schemas: { Error: errorSchema },
  },
} as const;
