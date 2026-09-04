import {
  DISCOVERY_DOCUMENT,
  ERROR_STATUS,
  OPENAPI_DOCUMENT,
  ProtocolRequestError,
  createErrorEnvelope,
  digestSecret,
  generateRequestId,
  parseCreateRoomRequest,
  parseEmptyRequest,
  parseJsonBody,
  parsePostMessageRequest,
  parsePublicId,
  parseStartInstanceRequest,
  type ErrorCode,
} from "../../protocol/src/index.ts";
import {
  RepositoryError,
  type IdempotencyScope,
  type InstanceAuth,
  type PrincipalAuth,
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
  if (!SNI_PATTERN.test(bearer)) return errorResponse("invalid_credentials");
  return (await store.authenticateInstance(bearer)) ?? errorResponse("invalid_credentials");
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
  auth: InstanceAuth,
  operationId: string,
  key: string,
  pathParameters: Record<string, string>,
  body: unknown,
  status: number,
  operation: () => Promise<unknown>,
): Promise<Response> {
  const scope: IdempotencyScope = {
    principalId: auth.principalId,
    credentialClass: "instance",
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

function parseMessageQuery(url: URL): { after: number; limit: number } {
  for (const key of url.searchParams.keys()) {
    if (key !== "after" && key !== "limit") {
      throw new ProtocolRequestError("invalid_request");
    }
  }
  const afterValue = url.searchParams.get("after");
  const limitValue = url.searchParams.get("limit");
  const after = afterValue === null ? 0 : Number(afterValue);
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new ProtocolRequestError("invalid_cursor");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ProtocolRequestError("invalid_request");
  }
  return { after, limit };
}

export async function handleRequest(
  request: Request,
  store?: SharedNetRepository,
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

    if (path === "/api/v1/agents/default") {
      if (request.method !== "PUT") return routeMethodNotAllowed("PUT");
      const repository = getRepository();
      const auth = await authenticateApiKey(request, repository);
      if (isResponse(auth)) return auth;
      return jsonResponse(
        { agent: await repository.ensureDefaultAgent(auth) },
        { status: 200 },
      );
    }

    const startInstanceMatch = /^\/api\/v1\/agents\/([^/]+)\/instances$/.exec(path);
    if (startInstanceMatch) {
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const auth = await authenticateApiKey(request, repository);
      if (isResponse(auth)) return auth;
      requireNoIdempotency(request);
      const agentId = parsePublicId(startInstanceMatch[1], "a");
      const input = await requiredJson(request, parseStartInstanceRequest);
      return jsonResponse(await repository.startInstance(auth, agentId, input), {
        status: 201,
        headers: NO_STORE_HEADERS,
      });
    }

    if (path === "/api/v1/instances/current") {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      return jsonResponse(await repository.getCurrentInstance(auth), { status: 200 });
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
      if (request.method !== "POST") return routeMethodNotAllowed("POST");
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
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
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      const key = getIdempotencyKey(request);
      const roomId = parsePublicId(joinMatch[1], "rom");
      const input = await optionalEmptyJson(request);
      return await executeIdempotent(
        repository,
        auth,
        "joinRoom",
        key,
        { room_id: roomId },
        input,
        200,
        () => repository.joinRoom(auth, roomId),
      );
    }

    const roomMatch = /^\/api\/v1\/rooms\/([^/]+)$/.exec(path);
    if (roomMatch) {
      if (request.method !== "GET") return routeMethodNotAllowed("GET");
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      const roomId = parsePublicId(roomMatch[1], "rom");
      return jsonResponse(await repository.getRoom(auth, roomId), { status: 200 });
    }

    const messagesMatch = /^\/api\/v1\/rooms\/([^/]+)\/messages$/.exec(path);
    if (messagesMatch) {
      const repository = getRepository();
      const auth = await authenticateInstance(request, repository);
      if (isResponse(auth)) return auth;
      const roomId = parsePublicId(messagesMatch[1], "rom");
      if (request.method === "GET") {
        return jsonResponse(
          await repository.listMessages(auth, roomId, parseMessageQuery(url)),
          { status: 200 },
        );
      }
      if (request.method === "POST") {
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
