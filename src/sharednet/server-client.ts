import "server-only";

import {
  type DecisionListResponse,
  type DecisionId,
  type DecisionProjection,
  type DecisionResolution,
  isDecisionListResponse,
  isDecisionProjection,
  isNetworkProjection,
  isProvisionAccountResponse,
  isRoomDetail,
  isRoomListResponse,
  type NetworkProjection,
  type PairingId,
  type ProvisionAccountResponse,
  type RoomDetail,
  type RoomId,
  type RoomListResponse,
} from "./contracts";

const REQUEST_TIMEOUT_MS = 10_000;

type ResponsePredicate<T> = (value: unknown) => value is T;

export class SharedNetApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SharedNetApiError";
    this.code = code;
    this.status = status;
  }
}

function requiredEnvironmentValue(
  name: "SHAREDNET_API_URL" | "SHAREDNET_CONSOLE_TOKEN",
): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be configured for the SharedNet server client`);
  }
  return value;
}

function sharedNetApiOrigin(): string {
  const value = requiredEnvironmentValue("SHAREDNET_API_URL");
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "SHAREDNET_API_URL must be an HTTP(S) origin without credentials, path, query, or fragment",
    );
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "SHAREDNET_API_URL must be an HTTP(S) origin without credentials, path, query, or fragment",
    );
  }

  return url.origin;
}

function isApiErrorPayload(
  value: unknown,
): value is { error: { code: string; message: string } } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("error" in value)
  ) {
    return false;
  }
  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    Object.keys(error).length === 2 &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0 &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  );
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function isTimeoutError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "TimeoutError"
  );
}

export class SharedNetServerClient {
  readonly #apiUrl: string;
  readonly #consoleToken: string;

  constructor(apiUrl: string, consoleToken: string) {
    this.#apiUrl = apiUrl.trim().replace(/\/+$/, "");
    this.#consoleToken = consoleToken;
  }

  async provisionAccount(authUserId: string): Promise<ProvisionAccountResponse> {
    return this.#request(
      "POST",
      `${this.#accountPath(authUserId)}/provision`,
      isProvisionAccountResponse,
    );
  }

  async claimPairing(
    authUserId: string,
    pairingId: PairingId,
  ): Promise<DecisionProjection> {
    return this.#request(
      "POST",
      `${this.#accountPath(authUserId)}/pairings/${pathSegment(pairingId)}/claim`,
      isDecisionProjection,
    );
  }

  async listRooms(authUserId: string): Promise<RoomListResponse> {
    return this.#request(
      "GET",
      `${this.#accountPath(authUserId)}/rooms`,
      isRoomListResponse,
    );
  }

  async getRoom(authUserId: string, roomId: RoomId): Promise<RoomDetail> {
    return this.#request(
      "GET",
      `${this.#accountPath(authUserId)}/rooms/${pathSegment(roomId)}`,
      isRoomDetail,
    );
  }

  async getNetwork(authUserId: string): Promise<NetworkProjection> {
    return this.#request(
      "GET",
      `${this.#accountPath(authUserId)}/network`,
      isNetworkProjection,
    );
  }

  async listDecisions(authUserId: string): Promise<DecisionListResponse> {
    return this.#request(
      "GET",
      `${this.#accountPath(authUserId)}/decisions`,
      isDecisionListResponse,
    );
  }

  async resolveDecision(
    authUserId: string,
    decisionId: DecisionId,
    resolution: DecisionResolution,
  ): Promise<DecisionProjection> {
    const body = {
      outcome: resolution.outcome,
      ...(resolution.responseText === undefined
        ? {}
        : { response_text: resolution.responseText }),
    };
    return this.#request(
      "POST",
      `${this.#accountPath(authUserId)}/decisions/${pathSegment(decisionId)}/resolve`,
      isDecisionProjection,
      body,
    );
  }

  #accountPath(authUserId: string): string {
    return `/v1/console/accounts/${pathSegment(authUserId)}`;
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    isExpectedResponse: ResponsePredicate<T>,
    body?: object,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#apiUrl}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-SharedNet-Console-Token": this.#consoleToken,
        },
        method,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new SharedNetApiError(
          "sharednet_api_timeout",
          504,
          "SharedNet API request timed out",
        );
      }
      throw new SharedNetApiError(
        "sharednet_api_unavailable",
        502,
        "SharedNet API is unavailable",
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      if (isApiErrorPayload(payload)) {
        throw new SharedNetApiError(
          payload.error.code,
          response.status,
          payload.error.message,
        );
      }
      throw new SharedNetApiError(
        "sharednet_api_error",
        response.status,
        `SharedNet API request failed with status ${response.status}`,
      );
    }

    if (!isExpectedResponse(payload)) {
      throw new SharedNetApiError(
        "invalid_sharednet_response",
        502,
        "SharedNet API returned an invalid response",
      );
    }

    return payload;
  }
}

export function getSharedNetServerClient(): SharedNetServerClient {
  return new SharedNetServerClient(
    sharedNetApiOrigin(),
    requiredEnvironmentValue("SHAREDNET_CONSOLE_TOKEN"),
  );
}
