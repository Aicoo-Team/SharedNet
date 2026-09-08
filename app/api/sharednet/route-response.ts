import "server-only";

import {
  SharedNetAuthError,
  SharedNetOriginError,
} from "@/src/sharednet/current-account";
import { SharedNetApiError } from "@/src/sharednet/server-client";

const SAFE_API_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const RESPONSE_HEADERS = { "Cache-Control": "private, no-store" };

class SharedNetRouteInputError extends Error {
  readonly code: "invalid_request" | "invalid_route_id";
  readonly status = 400;

  constructor(
    code: "invalid_request" | "invalid_route_id",
    message: string,
  ) {
    super(message);
    this.name = "SharedNetRouteInputError";
    this.code = code;
  }
}

export function invalidRequest(): SharedNetRouteInputError {
  return new SharedNetRouteInputError("invalid_request", "Invalid request");
}

export function invalidRouteIdentifier(): SharedNetRouteInputError {
  return new SharedNetRouteInputError(
    "invalid_route_id",
    "Invalid route identifier",
  );
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { headers: RESPONSE_HEADERS, status },
  );
}

function hasSafeApiErrorMetadata(error: SharedNetApiError): boolean {
  return (
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599 &&
    SAFE_API_ERROR_CODE.test(error.code)
  );
}

export async function sharedNetResponse<T>(
  operation: () => Promise<T>,
): Promise<Response> {
  try {
    return Response.json(await operation(), { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof SharedNetAuthError || error instanceof SharedNetOriginError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof SharedNetRouteInputError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof SharedNetApiError) {
      if (hasSafeApiErrorMetadata(error)) {
        return errorResponse(
          error.status,
          error.code,
          "SharedNet request failed",
        );
      }
      return errorResponse(
        502,
        "sharednet_api_error",
        "SharedNet request failed",
      );
    }
    return errorResponse(500, "internal_error", "SharedNet request failed");
  }
}
