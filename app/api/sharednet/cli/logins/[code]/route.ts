import { requireAuthUserId } from "@/src/sharednet/current-account";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import { invalidRouteIdentifier, sharedNetResponse } from "../../../route-response";

type LoginRouteContext = {
  params: Promise<{ code: string }>;
};

const CODE = /^[A-Za-z0-9-]{8,9}$/;

/** What the approve page shows for a code. Signed-in only; nothing secret. */
export function GET(request: Request, { params }: LoginRouteContext): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireAuthUserId(request.headers);
    const { code } = await params;
    if (!CODE.test(code)) throw invalidRouteIdentifier();
    return getSharedNetServerClient().getCliLogin(authUserId, code);
  });
}
