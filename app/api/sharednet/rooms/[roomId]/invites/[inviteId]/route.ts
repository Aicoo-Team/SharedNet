import { requireAuthUserId } from "@/src/sharednet/current-account";
import { parseRoomId } from "@/src/sharednet/contracts";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import {
  invalidRouteIdentifier,
  sharedNetResponse,
} from "../../../../route-response";

type RevokeRouteContext = {
  params: Promise<{ inviteId: string; roomId: string }>;
};

const INVITE_ID = /^inv_[0-9A-Za-z]{10}$/;

/** Revoke an invite: the door closes, members already inside stay. */
export function DELETE(
  request: Request,
  { params }: RevokeRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireAuthUserId(request.headers);
    const { inviteId, roomId: untrustedRoomId } = await params;
    const roomId = parseRoomId(untrustedRoomId);
    if (roomId === null || !INVITE_ID.test(inviteId)) throw invalidRouteIdentifier();
    return getSharedNetServerClient().revokeRoomInvite(authUserId, roomId, inviteId);
  });
}
