import { requireAuthUserId } from "@/src/sharednet/current-account";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import { invalidRouteIdentifier, sharedNetResponse } from "../../../../route-response";

type ApproveRouteContext = {
  params: Promise<{ code: string }>;
};

const CODE = /^[A-Za-z0-9-]{8,9}$/;

/** Approve a pending CLI login as this account, binding the seats it holds. */
export function POST(request: Request, { params }: ApproveRouteContext): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireAuthUserId(request.headers);
    const { code } = await params;
    if (!CODE.test(code)) throw invalidRouteIdentifier();
    return getSharedNetServerClient().approveCliLogin(authUserId, code);
  });
}
