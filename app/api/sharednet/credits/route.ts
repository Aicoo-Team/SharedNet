import { requireAuthUserId } from "@/src/sharednet/current-account";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import { sharedNetResponse } from "../route-response";

/** The account's purse and its ledger, for the one page that shows credits. */
export function GET(request: Request): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireAuthUserId(request.headers);
    return getSharedNetServerClient().getCredits(authUserId);
  });
}
