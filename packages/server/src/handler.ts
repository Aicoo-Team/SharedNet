import {
  type CliLoginId,
  CLI_LOGIN_ID_PATTERN,
  CLP_SECRET_PATTERN,
  parseStartCliLoginRequest,
  parseJoinRoomRequest,
  parseInboxCursor,
  type InboxPosition,
  DISCOVERY_DOCUMENT,
  ERROR_STATUS,
  DEFAULT_MESSAGE_QUERY,
  MIN_CLI_VERSION,
  type MessageQuery,
  OPENAPI_DOCUMENT,
  compareVersions,
  isVersionString,
  ProtocolRequestError,
  createErrorEnvelope,
  digestSecret,
  generateRequestId,
  parseCreateAgentRequest,
  parseCreateRoomRequest,
  parseArtifactContentType,
  parseArtifactFilename,
  type ArtifactId,
  type ArtifactQuery,
  ARTIFACT_ID_PATTERN,
  AFK_SECRET_PATTERN,
  MAX_ARTIFACT_BYTES,
  parseCreditTransferRequest,
  parseRedeemCreditsRequest,
  TRANSFER_ID_PATTERN,
  type TransferId,
  parseAddRoomMembersRequest,
  parseResolveDecisionRequest,
  parseUpdateInstanceRequest,
  parseEmptyRequest,
  parseJoinRoomWithInviteRequest,
  parseJsonBody,
  parsePostMessageRequest,
  parsePublicId,
  parseStartInstanceRequest,
  type ErrorCode,
} from "../../protocol/src/index.ts";
import {
  RepositoryError,
  type CreditAuth,
  type CreditLedgerQuery,
  type IdempotencyScope,
  type InstanceAuth,
  type PrincipalAuth,
  type RoomAuth,
  type SharedNetRepository,
} from "./repository.ts";
import { createRuntimeRepository } from "./runtime-repository.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const NO_STORE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "cdn-cache-control": "no-store",
  "vercel-cdn-cache-control": "no-store",
  pragma: "no-cache",
};
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNK_PATTERN = /^snk_[A-Za-z0-9_-]{43}$/;
const SNI_PATTERN = /^sni_[A-Za-z0-9_-]{43}$/;
const RIT_PATTERN = /^rit_[A-Za-z0-9_-]{43}$/;
const RMT_PATTERN = /^rmt_[A-Za-z0-9_-]{43}$/;
/** `wait` blocks at most this long; Vercel functions are capped not far above it. */
const WAIT_MAX_SECONDS = 25;
const DEFAULT_WAIT_POLL_MS = 1000;

export type HandlerOptions = {
  /** How often `wait` re-checks the Room while blocking. Tests shorten it. */
  waitPollMs?: number;
};

let runtimeRepository: SharedNetRepository | undefined;

export function sharedNetStore(): SharedNetRepository {
  runtimeRepository ??= createRuntimeRepository();
  return runtimeRepository;
}

function jsonResponse(
  value: unknown,
  init: ResponseInit & { headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(JSON_HEADERS);
  if (init.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

function errorResponse(code: ErrorCode, extraHeaders?: HeadersInit): Response {
  return jsonResponse(createErrorEnvelope(code, generateRequestId()), {
    status: ERROR_STATUS[code],
    headers: extraHeaders,
  });
}

function parseBearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (value === null) return null;
  if (value.includes(",") || !/^[\x20-\x7e]+$/.test(value)) return "";
  const match = /^Bearer ([^ ]+)$/.exec(value);
  return match?.[1] ?? "";
}

async function authenticateApiKey(
  request: Request,
  store: SharedNetRepository,
): Promise<PrincipalAuth | Response> {
  const bearer = parseBearer(request);
  if (bearer === null) return errorResponse("authentication_required");
  if (!SNK_PATTERN.test(bearer)) return errorResponse("invalid_credentials");
  return (await store.authenticateApiKey(bearer)) ?? errorResponse("invalid_credentials");
}

async function authenticateInstance(
  request: Request,
  store: SharedNetRepository,
): Promise<InstanceAuth | Response> {
  const bearer = parseBearer(request);
  if (bearer === null) return errorResponse("authentication_required");
  // An rmt_ minted before migration 0007 is the token of the Instance its
  // guest was converted into, on every Instance route, not only Room routes.
  if (!SNI_PATTERN.test(bearer) && !RMT_PATTERN.test(bearer)) {
    return errorResponse("invalid_credentials");
  }
  return (await store.authenticateInstance(bearer)) ?? errorResponse("invalid_credentials");
}

/**
 * Room routes take an Instance token. Every member is an Instance since
 * migration 0007; an `rmt_` minted before it still authenticates, as the
 * token of the Instance its guest was converted into.
 */
async function authenticateRoomMember(
  request: Request,
  store: SharedNetRepository,
): Promise<RoomAuth | Response> {
  const bearer = parseBearer(request);
  if (bearer === null) return errorResponse("authentication_required");
  if (SNI_PATTERN.test(bearer) || RMT_PATTERN.test(bearer)) {
    return (await store.authenticateInstance(bearer)) ?? errorResponse("invalid_credentials");
  }
  return errorResponse("invalid_credentials");
}

/**
 * Credits are the Principal's, so the purse answers to either credential: an
 * account key, or the token of one of the account's Instances (which then
 * records which seat paid).
 */
async function authenticateCreditHolder(
  request: Request,
  store: SharedNetRepository,
): Promise<CreditAuth | Response> {
  const bearer = parseBearer(request);
  if (bearer === null) return errorResponse("authentication_required");
  if (SNK_PATTERN.test(bearer)) {
    return (await store.authenticateApiKey(bearer)) ?? errorResponse("invalid_credentials");
  }
  if (SNI_PATTERN.test(bearer) || RMT_PATTERN.test(bearer)) {
    return (await store.authenticateInstance(bearer)) ?? errorResponse("invalid_credentials");
  }
  return errorResponse("invalid_credentials");
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function hasJsonContentType(request: Request): boolean {
  const value = request.headers.get("content-type");
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function requiredJson<T>(request: Request, parser: (input: unknown) => T): Promise<T> {
  if (!hasJsonContentType(request)) {
    throw new ProtocolRequestError("unsupported_media_type");
  }
  return parseJsonBody(await request.text(), parser);
}

async function optionalEmptyJson(request: Request): Promise<Record<string, never>> {
  const text = await request.text();
  if (text.length === 0) return {};
  if (!hasJsonContentType(request)) {
    throw new ProtocolRequestError("unsupported_media_type");
  }
  return parseJsonBody(text, parseEmptyRequest);
}

/** A body that may be absent: an empty body parses as `undefined`; anything else must be JSON. */
async function optionalJson<T>(request: Request, parser: (value: unknown) => T): Promise<T> {
  const text = await request.text();
  if (text.length === 0) return parser(undefined);
  if (!hasJsonContentType(request)) {
    throw new ProtocolRequestError("unsupported_media_type");
  }
  return parseJsonBody(text, parser);
}

function requireNoIdempotency(request: Request): void {
  if (request.headers.has("idempotency-key")) {
    throw new ProtocolRequestError("idempotency_not_supported");
  }
}

function getIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (key === null) throw new ProtocolRequestError("missing_idempotency_key");
  if (!UUID_V4_PATTERN.test(key)) {
    throw new ProtocolRequestError("invalid_idempotency_key");
  }
  return key.toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function executeIdempotent(
  store: SharedNetRepository,
  auth: RoomAuth | CreditAuth,
  operationId: string,
  key: string,
  pathParameters: Record<string, string>,
  body: unknown,
  status: number,
  operation: () => Promise<unknown>,
): Promise<Response> {
  const scope: IdempotencyScope = {
    principalId: auth.principalId,
    credentialClass: auth.kind,
    actorId: auth.actorId,
    operationId,
    key,
  };
  const fingerprint = digestSecret(
    canonicalJson({ operation_id: operationId, path_parameters: pathParameters, body }),
  );
  const result = await store.executeIdempotent(scope, fingerprint, async () => ({
    status,
    body: JSON.stringify(await operation()),
  }));
  return new Response(result.body, {
    status: result.status,
    headers: {
      ...JSON_HEADERS,
      ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
    },
  });
}

function routeMethodNotAllowed(allow: string): Response {
  return errorResponse("method_not_allowed", { allow });
}

const MESSAGE_QUERY_KEYS = ["after", "before", "limit", "order", "sender_instance_id", "sender_agent_id", "q"] as const;

/** Filter, order, window. Unknown keys are refused; filters compose with AND. */
function parseMessageQuery(url: URL, allowed: readonly string[] = MESSAGE_QUERY_KEYS): MessageQuery {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) {
      throw new ProtocolRequestError("invalid_request");
    }
  }
  const afterValue = url.searchParams.get("after");
  const beforeValue = url.searchParams.get("before");
  const limitValue = url.searchParams.get("limit");
  const orderValue = url.searchParams.get("order");
  const after = afterValue === null ? 0 : Number(afterValue);
  const before = beforeValue === null ? null : Number(beforeValue);
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new ProtocolRequestError("invalid_cursor");
  }
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
    throw new ProtocolRequestError("invalid_cursor");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ProtocolRequestError("invalid_request");
  }
  if (orderValue !== null && orderValue !== "asc" && orderValue !== "desc") {
    throw new ProtocolRequestError("invalid_request");
  }
  // `before` pages backward and implies desc; `after` with `before` or with desc is contradictory.
  const order: MessageQuery["order"] = orderValue === "desc" || (orderValue === null && before !== null) ? "desc" : "asc";
  if (before !== null && afterValue !== null) throw new ProtocolRequestError("invalid_request");
  if (before !== null && order === "asc") throw new ProtocolRequestError("invalid_request");
  if (afterValue !== null && order === "desc") throw new ProtocolRequestError("invalid_request");
  const senderInstance = url.searchParams.get("sender_instance_id");
  const senderAgent = url.searchParams.get("sender_agent_id");
  const q = url.searchParams.get("q");
  if (q !== null && (q.length === 0 || [...q].length > 256 || /[\p{Cc}]/u.test(q))) {
    throw new ProtocolRequestError("invalid_request");
  }
  return {
    after,
    before,
    limit,
    order,
    sender_instance_id: senderInstance === null ? null : parsePublicId(senderInstance, "i"),
    sender_agent_id: senderAgent === null ? null : senderAgent === "default" ? "default" : parsePublicId(senderAgent, "a"),
    q,
  };
}

/** The inbox cursor is opaque: absent means the beginning, malformed is an error. */
function parseInboxQuery(url: URL): { after: InboxPosition | null; limit: number } {
  for (const key of url.searchParams.keys()) {
    if (key !== "after" && key !== "limit") {
      throw new ProtocolRequestError("invalid_request");
    }
  }
  const afterValue = url.searchParams.get("after");
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ProtocolRequestError("invalid_request");
  }
  if (afterValue === null || afterValue === "") return { after: null, limit };
  const after = parseInboxCursor(afterValue);
  if (after === null) throw new ProtocolRequestError("invalid_cursor");
  return { after, limit };
}

/**
 * An upload is headers plus bytes: the filename, the Room it is handed to and
 * the reach ride in headers so the body can be the file itself, which is what
 * makes `curl --data-binary @file` and a CLI stream both work without base64.
 */
function parseUploadHeaders(request: Request): {
  filename: string;
  content_type: string;
  room_id: `rom_${string}` | null;
} {
  const encodedFilename = request.headers.get("x-sharednet-filename*");
  let filenameValue = request.headers.get("x-sharednet-filename");
  if (encodedFilename !== null) {
    if (!encodedFilename.startsWith("UTF-8''")) throw new ProtocolRequestError("validation_failed");
    try {
      filenameValue = decodeURIComponent(encodedFilename.slice(7));
    } catch {
      throw new ProtocolRequestError("validation_failed");
    }
  }
  const filename = parseArtifactFilename(filenameValue);
  const room = request.headers.get("x-sharednet-room");
  return {
    filename,
    content_type: parseArtifactContentType(request.headers.get("content-type")),
    room_id: room === null || room === "" ? null : parsePublicId(room, "rom"),
  };
}

/** Files page newest-first by artifact id; absent means the latest. */
function parseArtifactQuery(url: URL): ArtifactQuery {
  for (const key of url.searchParams.keys()) {
    if (key !== "room_id" && key !== "before" && key !== "limit") throw new ProtocolRequestError("invalid_request");
  }
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProtocolRequestError("invalid_request");
  const before = url.searchParams.get("before");
  if (before !== null && !ARTIFACT_ID_PATTERN.test(before)) throw new ProtocolRequestError("invalid_cursor");
  const room = url.searchParams.get("room_id");
  return {
    room_id: room === null ? null : parsePublicId(room, "rom"),
    before: before as ArtifactId | null,
    limit,
  };
}

/**
 * Bytes always leave as an attachment, with the sniffing turned off and the
 * type narrowed to a short safe list. An artifact is arbitrary bytes that
 * somebody else uploaded; served inline from our own origin, an HTML file
 * would run as our page.
 */
const INLINE_SAFE_TYPES = new Set([
  "application/json",
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

function artifactResponse(artifact: { filename: string; content_type: string; size_bytes: number; sha256: string }, bytes: Uint8Array): Response {
  const declared = INLINE_SAFE_TYPES.has(artifact.content_type) ? artifact.content_type : "application/octet-stream";
  // SVG is safe to store and to download, never to render from our origin.
  const type = declared === "image/svg+xml" ? "application/octet-stream" : declared;
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(artifact.size_bytes),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-sharednet-sha256": artifact.sha256,
      ...NO_STORE_HEADERS,
    },
  });
}

/** The ledger pages newest-first by transfer id; absent means the latest. */
function parseLedgerQuery(url: URL): CreditLedgerQuery {
  for (const key of url.searchParams.keys()) {
    if (key !== "before" && key !== "limit") throw new ProtocolRequestError("invalid_request");
  }
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProtocolRequestError("invalid_request");
  const before = url.searchParams.get("before");
  if (before !== null && !TRANSFER_ID_PATTERN.test(before)) throw new ProtocolRequestError("invalid_cursor");
  return { limit, before: before as TransferId | null };
}

function parseWaitQuery(url: URL): { after: number; limit: number; timeoutMs: number } {
  const page = parseMessageQuery(url, ["after", "limit", "timeout"]);
  const timeoutValue = url.searchParams.get("timeout");
  const timeout = timeoutValue === null ? WAIT_MAX_SECONDS : Number(timeoutValue);
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > WAIT_MAX_SECONDS) {
    throw new ProtocolRequestError("invalid_request");
  }
  return { ...page, timeoutMs: timeout * 1000 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sit in the Room until something is said after `after`, or until the timeout.
 * Plain polling on purpose: it needs no connection state, works on serverless,
 * and every poll renews the caller's presence.
 */
async function waitForMessages(
  repository: SharedNetRepository,
  auth: RoomAuth,
  roomId: `rom_${string}`,
  query: { after: number; limit: number; timeoutMs: number },
  pollMs: number,
): Promise<unknown> {
  const deadline = Date.now() + query.timeoutMs;
  for (;;) {
    const page = await repository.listMessages(auth, roomId, {
      ...DEFAULT_MESSAGE_QUERY,
      after: query.after,
      limit: query.limit,
    });
    if (page.items.length > 0) return page;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return page;
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function handleRequest(
  request: Request,
  store?: SharedNetRepository,
  options: HandlerOptions = {},
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (path === "/api/v1") {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      return jsonResponse(DISCOVERY_DOCUMENT, { status: 200 });
    }

    if (path === "/api/v1/openapi.json") {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      return jsonResponse(OPENAPI_DOCUMENT, { status: 200 });
    }

    const getRepository = () => store ?? sharedNetStore();

    if (path === "/api/v1/agents") {
      const repository = getRepository();
      const auth = await authenticateApiKey(request, repository);
      if (isResponse(auth)) return auth;
      if (request.method === "POST") {
        requireNoIdempotency(request);
        const input = await requiredJson(request, parseCreateAgentRequest);
        const { agent, created } = await repository.createAgent(auth, input);
        return jsonResponse({ agent }, { status: created ? 201 : 200 });
      }
      if (request.method === "GET") {
        return jsonResponse(await repository.listAgents(auth), { status: 200 });
      }
      return routeMethodNotAllowed("GET, POST");
    }

    const agentMatch = /^\/api\/v1\/agents\/([^/]+)$/.exec(path);
    if (agentMatch) {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const auth = await authenticateApiKey(request, repository);
      if (isResponse(auth)) return auth;
      const agentId = parsePublicId(agentMatch[1], "a");
      return jsonResponse(await repository.getAgent(auth, agentId), { status: 200 });
    }

    if (path === "/api/v1/instances") {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const auth = await authenticateApiKey(request, repository);
      if (isResponse(auth)) return auth;
      // local_instance_key is this route's idempotency; a key header would
      // only create a second, weaker notion of "the same request".
      requireNoIdempotency(request);
      const input = await requiredJson(request, parseStartInstanceRequest);
      // A CLI with a known-bad join is not registered; it is told what to run.
      if (isVersionString(input.cli_version) && compareVersions(input.cli_version, MIN_CLI_VERSION) < 0) {
        return jsonResponse(
          {
            error: {
              code: "cli_upgrade_required",
              message: `This SharedNet CLI (${input.cli_version.trim()}) is older than ${MIN_CLI_VERSION}. Run it as npx -y sharednet@latest, or update a global install with npm install -g sharednet@latest.`,
              request_id: generateRequestId(),
            },
          },
          { status: 426 },
        );
      }
      const { created, ...result } = await repository.startInstance(auth, input);
      return jsonResponse(result, {
        status: created ? 201 : 200,
        headers: NO_STORE_HEADERS,
      });
    }

    if (path === "/api/v1/instances/current") {
      if (request.method !== "GET" && request.method !== "PATCH") return routeMethodNotAllowed("GET, PATCH");
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      if (request.method === "PATCH") {
        // What an Instance may change about itself: today its reach.
        const input = await requiredJson(request, parseUpdateInstanceRequest);
        return jsonResponse(await repository.updateInstance(auth, input), { status: 200 });
      }
      return jsonResponse(await repository.getCurrentInstance(auth), { status: 200 });
    }

    if (path === "/api/v1/cli/claims/redeem") {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const bearer = parseBearer(request);
      if (bearer === null) return errorResponse("authentication_required");
      if (!CLP_SECRET_PATTERN.test(bearer)) return errorResponse("invalid_credentials");
      await optionalEmptyJson(request);
      // A claim minted by the signed-in Web for its own account: one redemption
      // hands the CLI the key; the code is spent on the spot.
      return jsonResponse(await repository.redeemCliClaim(bearer), { status: 200, headers: NO_STORE_HEADERS });
    }

    if (path === "/api/v1/invites/current") {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const bearer = parseBearer(request);
      if (bearer === null) return errorResponse("authentication_required");
      if (!RIT_PATTERN.test(bearer)) return errorResponse("invalid_credentials");
      // The join page asks what the invite opens; the token is the only credential.
      return jsonResponse(await repository.describeInvite(bearer), { status: 200, headers: NO_STORE_HEADERS });
    }

    if (path === "/api/v1/decisions") {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      const status = url.searchParams.get("status");
      if (
        status !== null &&
        status !== "pending" &&
        status !== "approved" &&
        status !== "denied" &&
        status !== "answered"
      ) {
        return errorResponse("validation_failed");
      }
      return jsonResponse(await repository.listDecisions(auth, status === null ? {} : { status }), {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }

    const resolveMatch = /^\/api\/v1\/decisions\/([^/]+)\/resolve$/.exec(path);
    if (resolveMatch) {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      const decisionId = parsePublicId(resolveMatch[1], "dec");
      const input = await requiredJson(request, parseResolveDecisionRequest);
      return jsonResponse(await repository.resolveDecision(auth, decisionId, input), { status: 200 });
    }

    if (path === "/api/v1/instances/current/heartbeat") {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      await optionalEmptyJson(request);
      return jsonResponse(await repository.heartbeat(auth), { status: 200 });
    }

    if (path === "/api/v1/rooms") {
      if (request.method !== "POST" && request.method !== "GET") return routeMethodNotAllowed("GET, POST");
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      if (request.method === "GET") {
        return jsonResponse(await repository.listRooms(auth), { status: 200, headers: NO_STORE_HEADERS });
      }
      const key = getIdempotencyKey(request);
      const input = await requiredJson(request, parseCreateRoomRequest);
      return await executeIdempotent(
        repository,
        auth,
        "createRoom",
        key,
        {},
        input,
        201,
        () => repository.createRoom(auth, input),
      );
    }

    const joinMatch = /^\/api\/v1\/rooms\/([^/]+)\/join$/.exec(path);
    if (joinMatch) {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const bearer = parseBearer(request);
      if (bearer !== null && RIT_PATTERN.test(bearer)) {
        // An Agent with only an invite: the join provisions an anonymous
        // Principal and an Instance for it. Every call admits a new member, so
        // there is nothing to make idempotent.
        const roomId = parsePublicId(joinMatch[1], "rom");
        const input = await requiredJson(request, parseJoinRoomWithInviteRequest);
        const joined = await repository.joinRoomWithInvite(bearer, roomId, input);
        return jsonResponse(joined, { status: 200, headers: NO_STORE_HEADERS });
      }
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      const key = getIdempotencyKey(request);
      const roomId = parsePublicId(joinMatch[1], "rom");
      // An Instance joins as its own Principal, optionally naming the invite
      // that admits it.
      const input = await optionalJson(request, parseJoinRoomRequest);
      return await executeIdempotent(
        repository,
        auth,
        "joinRoom",
        key,
        { room_id: roomId },
        input,
        200,
        () => repository.joinRoom(auth, roomId, input),
      );
    }

    const membersMatch = /^\/api\/v1\/rooms\/([^/]+)\/members$/.exec(path);
    if (membersMatch) {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const auth = await authenticateRoomMember(request, repository);
      if (isResponse(auth)) return auth;
      const roomId = parsePublicId(membersMatch[1], "rom");
      const input = await requiredJson(request, parseAddRoomMembersRequest);
      return jsonResponse(await repository.addRoomMembers(auth, roomId, input), { status: 200 });
    }

    const waitMatch = /^\/api\/v1\/rooms\/([^/]+)\/wait$/.exec(path);
    if (waitMatch) {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const auth = await authenticateRoomMember(request, repository);
      if (isResponse(auth)) return auth;
      const roomId = parsePublicId(waitMatch[1], "rom");
      const query = parseWaitQuery(url);
      return jsonResponse(
        await waitForMessages(
          repository,
          auth,
          roomId,
          query,
          options.waitPollMs ?? DEFAULT_WAIT_POLL_MS,
        ),
        { status: 200, headers: NO_STORE_HEADERS },
      );
    }

    const invitesMatch = /^\/api\/v1\/rooms\/([^/]+)\/invites$/.exec(path);
    if (invitesMatch) {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      requireNoIdempotency(request);
      await optionalEmptyJson(request);
      const roomId = parsePublicId(invitesMatch[1], "rom");
      // Only the Principal that owns the Room may open a door into it; an
      // Instance of any other Principal, anonymous or not, is told the Room
      // does not exist. The raw token is returned once. The link is the same
      // invite for people: whoever opens it signs in and hands their Agent a
      // command that joins as their account.
      const { invite, token } = await repository.createRoomInvite({ roomId, principalId: auth.principalId });
      return jsonResponse(
        { invite, token, link: new URL(`/join/${token}`, url.origin).toString() },
        { status: 201, headers: NO_STORE_HEADERS },
      );
    }

    const roomMatch = /^\/api\/v1\/rooms\/([^/]+)$/.exec(path);
    if (roomMatch) {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const auth = await authenticateRoomMember(request, repository);
      if (isResponse(auth)) return auth;
      const roomId = parsePublicId(roomMatch[1], "rom");
      return jsonResponse(await repository.getRoom(auth, roomId), { status: 200 });
    }

    if (path === "/api/v1/artifacts") {
      if (request.method !== "POST" && request.method !== "GET") return routeMethodNotAllowed("GET, POST");
      const repository = getRepository();
      const auth = await authenticateCreditHolder(request, repository);
      if (isResponse(auth)) return auth;
      if (request.method === "GET") {
        return jsonResponse(await repository.listArtifacts(auth, parseArtifactQuery(url)), {
          status: 200,
          headers: NO_STORE_HEADERS,
        });
      }
      const key = getIdempotencyKey(request);
      const input = parseUploadHeaders(request);
      const body = new Uint8Array(await request.arrayBuffer());
      // Refused on its size before the store is asked to hold it.
      if (body.byteLength > MAX_ARTIFACT_BYTES) return errorResponse("artifact_too_large");
      return await executeIdempotent(
        repository,
        auth,
        "uploadArtifact",
        key,
        {},
        { ...input, sha256: digestSecret(Buffer.from(body).toString("base64")) },
        201,
        async () => {
          const { artifact, link_key: linkKey } = await repository.uploadArtifact(auth, { ...input, bytes: body });
          // The link comes back exactly once, with the file it opens.
          return { artifact, link_key: linkKey, url: new URL(`/f/${artifact.id}?k=${linkKey}`, url.origin).toString() };
        },
      );
    }

    const artifactContentMatch = /^\/api\/v1\/artifacts\/([^/]+)\/content$/.exec(path);
    if (artifactContentMatch) {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const artifactId = parsePublicId(artifactContentMatch[1], "art");
      // The link key is a credential of its own: it opens this one file and
      // nothing else, so a reader with no account can still be handed a file.
      const linkKey = url.searchParams.get("k");
      if (linkKey !== null) {
        if (!AFK_SECRET_PATTERN.test(linkKey)) return errorResponse("artifact_not_found");
        const opened = await repository.readArtifactByLink(artifactId, linkKey);
        return artifactResponse(opened.artifact, opened.bytes);
      }
      const auth = await authenticateCreditHolder(request, repository);
      if (isResponse(auth)) return auth;
      const read = await repository.readArtifact(auth, artifactId);
      return artifactResponse(read.artifact, read.bytes);
    }

    const artifactMatch = /^\/api\/v1\/artifacts\/([^/]+)$/.exec(path);
    if (artifactMatch) {
      if (request.method !== "GET" && request.method !== "DELETE") return routeMethodNotAllowed("DELETE, GET");
      const repository = getRepository();
      const auth = await authenticateCreditHolder(request, repository);
      if (isResponse(auth)) return auth;
      const artifactId = parsePublicId(artifactMatch[1], "art");
      if (request.method === "DELETE") {
        return jsonResponse(await repository.deleteArtifact(auth, artifactId), { status: 200, headers: NO_STORE_HEADERS });
      }
      return jsonResponse(await repository.getArtifact(auth, artifactId), { status: 200, headers: NO_STORE_HEADERS });
    }

    if (path === "/api/v1/credits") {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const auth = await authenticateCreditHolder(request, repository);
      if (isResponse(auth)) return auth;
      return jsonResponse(await repository.getCredits(auth), { status: 200, headers: NO_STORE_HEADERS });
    }

    if (path === "/api/v1/credits/redeem") {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const auth = await authenticateCreditHolder(request, repository);
      if (isResponse(auth)) return auth;
      // Redeeming is idempotent by construction (once per code per Principal),
      // so a key would only add a second notion of "the same request".
      requireNoIdempotency(request);
      const input = await requiredJson(request, parseRedeemCreditsRequest);
      return jsonResponse(await repository.redeemCredits(auth, input.code), { status: 200, headers: NO_STORE_HEADERS });
    }

    if (path === "/api/v1/credits/transfers") {
      if (request.method !== "GET" && request.method !== "POST") return routeMethodNotAllowed("GET, POST");
      const repository = getRepository();
      const auth = await authenticateCreditHolder(request, repository);
      if (isResponse(auth)) return auth;
      if (request.method === "GET") {
        return jsonResponse(await repository.listCreditTransfers(auth, parseLedgerQuery(url)), {
          status: 200,
          headers: NO_STORE_HEADERS,
        });
      }
      // Money moves once: every payment carries a key, whoever the payer is.
      const key = getIdempotencyKey(request);
      const input = await requiredJson(request, parseCreditTransferRequest);
      return await executeIdempotent(
        repository,
        auth,
        "transferCredits",
        key,
        {},
        input,
        201,
        () => repository.transferCredits(auth, input),
      );
    }

    if (path === "/api/v1/cli/logins") {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      requireNoIdempotency(request);
      const input = await optionalJson(request, parseStartCliLoginRequest);
      const started = await repository.startCliLogin({
        label: input.label ?? null,
        seats: input.seats ?? [],
      });
      // The page that approves it lives on the same origin the CLI called.
      const verifyUrl = new URL(`/cli/authorize?code=${encodeURIComponent(started.user_code)}`, url.origin);
      return jsonResponse(
        {
          login: started.login,
          user_code: started.user_code,
          poll_token: started.poll_token,
          verify_url: verifyUrl.toString(),
          interval_seconds: 3,
        },
        { status: 201, headers: NO_STORE_HEADERS },
      );
    }

    const pollMatch = /^\/api\/v1\/cli\/logins\/([^/]+)\/poll$/.exec(path);
    if (pollMatch) {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const bearer = parseBearer(request);
      if (bearer === null) return errorResponse("authentication_required");
      if (!CLP_SECRET_PATTERN.test(bearer)) return errorResponse("invalid_credentials");
      const loginId = pollMatch[1]!;
      if (!CLI_LOGIN_ID_PATTERN.test(loginId)) return errorResponse("invalid_id");
      await optionalEmptyJson(request);
      const result = await repository.pollCliLogin(loginId as CliLoginId, bearer);
      return jsonResponse(result, { status: 200, headers: NO_STORE_HEADERS });
    }

    if (path === "/api/v1/inbox") {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const auth = await authenticateRoomMember(request, repository);
      if (isResponse(auth)) return auth;
      return jsonResponse(await repository.listInbox(auth, parseInboxQuery(url)), {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }

    const messagesMatch = /^\/api\/v1\/rooms\/([^/]+)\/messages$/.exec(path);
    if (messagesMatch) {
      const repository = getRepository();
      const auth = await authenticateRoomMember(request, repository);
      if (isResponse(auth)) return auth;
      const roomId = parsePublicId(messagesMatch[1], "rom");
      if (request.method === "GET") {
        return jsonResponse(
          await repository.listMessages(auth, roomId, parseMessageQuery(url)),
          { status: 200 },
        );
      }
      if (request.method === "POST") {
        // An invite-admitted Instance speaks with plain curl; an
        // Idempotency-Key is honoured when sent but not demanded. Key-issued
        // Instances keep the strict contract.
        if (auth.anonymous && !request.headers.has("idempotency-key")) {
          const input = await requiredJson(request, parsePostMessageRequest);
          return jsonResponse(await repository.postMessage(auth, roomId, input), {
            status: 201,
          });
        }
        const key = getIdempotencyKey(request);
        const input = await requiredJson(request, parsePostMessageRequest);
        return await executeIdempotent(
          repository,
          auth,
          "postMessage",
          key,
          { room_id: roomId },
          input,
          201,
          () => repository.postMessage(auth, roomId, input),
        );
      }
      return routeMethodNotAllowed("GET, POST");
    }

    return errorResponse("route_not_found");
  } catch (error) {
    if (error instanceof ProtocolRequestError) {
      return errorResponse(error.code);
    }
    if (error instanceof RepositoryError) {
      const code = error.code as ErrorCode;
      if (code in ERROR_STATUS) return errorResponse(code);
    }
    return errorResponse("internal_error");
  }
}
