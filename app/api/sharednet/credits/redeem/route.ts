import { parseRedeemCreditsRequest } from "@/packages/protocol/src/index.ts";
import { requireWebMutation } from "@/src/sharednet/current-account";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import { invalidRequest, sharedNetResponse } from "../../route-response";

/** The code as typed; the protocol's own parser decides what a code looks like. */
async function redeemInput(request: Request): Promise<{ code: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalidRequest();
  }
  try {
    return parseRedeemCreditsRequest(body);
  } catch {
    throw invalidRequest();
  }
}

/** Redeem a grant code for the signed-in account, from our own page only. */
export function POST(request: Request): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireWebMutation(request);
    const { code } = await redeemInput(request);
    return getSharedNetServerClient().redeemCredits(authUserId, code);
  });
}
