import { requireWebMutation } from "@/src/sharednet/current-account";
import { parseRoomId } from "@/src/sharednet/contracts";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import {
  invalidRouteIdentifier,
  sharedNetResponse,
} from "../../../../route-response";

type RemoveMemberRouteContext = {
  params: Promise<{ memberId: string; roomId: string }>;
};

/** A guest member is `mem_…`; an Instance member is addressed by its Instance id. */
const MEMBER_ID = /^(?:mem|i)_[0-9A-Za-z]{10}$/;

/** Remove one member from a Room this account owns. Its token stops working; what it said stays. */
export function DELETE(
  request: Request,
  { params }: RemoveMemberRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireWebMutation(request);
    const { memberId, roomId: untrustedRoomId } = await params;
    const roomId = parseRoomId(untrustedRoomId);
    if (roomId === null || !MEMBER_ID.test(memberId)) throw invalidRouteIdentifier();
    return getSharedNetServerClient().removeRoomMember(authUserId, roomId, memberId);
  });
}
