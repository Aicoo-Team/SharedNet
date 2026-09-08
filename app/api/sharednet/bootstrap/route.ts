import { requireWebMutation } from "@/src/sharednet/current-account";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import { sharedNetResponse } from "../route-response";

export function POST(request: Request): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireWebMutation(request);
    return getSharedNetServerClient().provisionAccount(authUserId);
  });
}
