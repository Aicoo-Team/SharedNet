import { requireAuthUserId } from "@/src/sharednet/current-account";
import { parseRoomId } from "@/src/sharednet/contracts";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import {
  invalidRouteIdentifier,
  sharedNetResponse,
} from "../../route-response";

type RoomRouteContext = {
  params: Promise<{ roomId: string }>;
};

export function GET(
  request: Request,
  { params }: RoomRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireAuthUserId(request.headers);
    const { roomId: untrustedRoomId } = await params;
    const roomId = parseRoomId(untrustedRoomId);
    if (roomId === null) throw invalidRouteIdentifier();
    return getSharedNetServerClient().getRoom(authUserId, roomId);
  });
}
