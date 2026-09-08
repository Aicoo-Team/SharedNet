import { requireWebMutation } from "@/src/sharednet/current-account";
import { parseRoomId } from "@/src/sharednet/contracts";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import {
  invalidRouteIdentifier,
  sharedNetResponse,
} from "../../../route-response";

type CloseRouteContext = {
  params: Promise<{ roomId: string }>;
};

/**
 * Close a Room this account owns. The one explicit end a Room has: members'
 * tokens stop working, history stays readable here. Closing twice is a no-op.
 */
export function POST(
  request: Request,
  { params }: CloseRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireWebMutation(request);
    const { roomId: untrustedRoomId } = await params;
    const roomId = parseRoomId(untrustedRoomId);
    if (roomId === null) throw invalidRouteIdentifier();
    return getSharedNetServerClient().closeRoom(authUserId, roomId);
  });
}
