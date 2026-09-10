import { requireWebMutation } from "@/src/sharednet/current-account";
import { parseRoomId } from "@/src/sharednet/contracts";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import {
  invalidRouteIdentifier,
  sharedNetResponse,
} from "../../../route-response";

type ShareRouteContext = {
  params: Promise<{ roomId: string }>;
};

/**
 * Publish a Room this account owns at a public, read-only link. Asking again
 * returns the same link; the link changes only after DELETE and a new POST.
 */
export function POST(
  request: Request,
  { params }: ShareRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireWebMutation(request);
    const { roomId: untrustedRoomId } = await params;
    const roomId = parseRoomId(untrustedRoomId);
    if (roomId === null) throw invalidRouteIdentifier();
    return getSharedNetServerClient().shareRoom(authUserId, roomId);
  });
}

/** Stop publishing. The link stops resolving at once; the Room itself is untouched. */
export function DELETE(
  request: Request,
  { params }: ShareRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireWebMutation(request);
    const { roomId: untrustedRoomId } = await params;
    const roomId = parseRoomId(untrustedRoomId);
    if (roomId === null) throw invalidRouteIdentifier();
    return getSharedNetServerClient().unshareRoom(authUserId, roomId);
  });
}
