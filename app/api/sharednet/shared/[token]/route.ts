import { SHR_SECRET_PATTERN } from "@/packages/protocol/src/index.ts";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import {
  invalidRouteIdentifier,
  sharedNetResponse,
} from "../../route-response";

type SharedRouteContext = {
  params: Promise<{ token: string }>;
};

/**
 * The one Dashboard route with no session behind it: what a share link
 * opens, for the public page to poll. The slug is the whole credential; an
 * unknown or revoked one reads as absent. Nothing in the response carries
 * an id of any kind (see `SharedRoomProjection`).
 */
export function GET(
  _request: Request,
  { params }: SharedRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const { token } = await params;
    if (!SHR_SECRET_PATTERN.test(token)) throw invalidRouteIdentifier();
    return getSharedNetServerClient().getSharedRoom(token);
  });
}
