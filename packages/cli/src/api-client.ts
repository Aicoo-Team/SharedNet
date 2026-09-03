import { CliError, asCliError, localError } from "./errors.ts";

type Fetch = typeof globalThis.fetch;

interface ApiErrorEnvelope {
  error?: {
    code?: unknown;
    request_id?: unknown;
  };
}

export function resolveBaseUrl(value: string | undefined): string {
  const candidate = value?.trim() || "https://sharednet.ai";
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw localError("invalid_base_url", "SHAREDNET_BASE_URL is not a valid URL.");
  }
  const localHttp = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !localHttp) {
    throw localError(
      "invalid_base_url",
      "SharedNet requires HTTPS except for 127.0.0.1 development servers.",
    );
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw localError("invalid_base_url", "SHAREDNET_BASE_URL must be an origin.");
  }
  return url.origin;
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : "api_error";
}

export class ApiClient {
  readonly baseUrl: string;
  readonly fetch: Fetch;

  constructor(baseUrl: string, fetchImplementation: Fetch = globalThis.fetch) {
    this.baseUrl = resolveBaseUrl(baseUrl);
    this.fetch = fetchImplementation;
  }

  async request<T>(
    method: string,
    path: string,
    credential: string,
    body?: unknown,
    requestHeaders: Record<string, string> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...requestHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CliError(
        "service_unavailable",
        "The SharedNet service could not be reached.",
        5,
      );
    }

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      try {
        return (await response.json()) as T;
      } catch {
        throw new CliError(
          "invalid_server_response",
          "The SharedNet service returned an invalid response.",
          5,
        );
      }
    }

    let envelope: ApiErrorEnvelope = {};
    try {
      envelope = (await response.json()) as ApiErrorEnvelope;
    } catch {
      // Status and a bounded local message are enough; never echo arbitrary bodies.
    }
    const code = safeErrorCode(envelope.error?.code);
    const requestId =
      typeof envelope.error?.request_id === "string" &&
      /^req_[A-Za-z0-9_-]+$/.test(envelope.error.request_id)
        ? envelope.error.request_id
        : undefined;
    if (response.status === 401) {
      throw new CliError(code, "SharedNet authentication failed.", 3, requestId);
    }
    if (response.status >= 400 && response.status < 500) {
      throw new CliError(code, "SharedNet rejected the request.", 4, requestId);
    }
    throw new CliError(code, "The SharedNet service is unavailable.", 5, requestId);
  }
}

export function transportError(error: unknown): CliError {
  return asCliError(error);
}
