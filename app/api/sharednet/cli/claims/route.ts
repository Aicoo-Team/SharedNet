import { requireWebMutation } from "@/src/sharednet/current-account";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import { invalidRequest, sharedNetResponse } from "../../route-response";

/**
 * Mint a claim code for this account. The join page puts it into the Agent's
 * command; the CLI redeems it once for the account's API key and joins as
 * the account. Nothing but a signed-in session can mint one.
 */
export function POST(request: Request): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireWebMutation(request);
    const body: unknown = await request.json().catch(() => ({}));
    const label = typeof body === "object" && body !== null && "label" in body ? (body as { label: unknown }).label : null;
    if (label !== null && (typeof label !== "string" || label.length > 120)) throw invalidRequest();
    return getSharedNetServerClient().createCliClaim(authUserId, label === "" ? null : label);
  });
}
