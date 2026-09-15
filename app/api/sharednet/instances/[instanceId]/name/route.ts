import { parseSeatName } from "@/packages/protocol/src/index.ts";
import { requireWebMutation } from "@/src/sharednet/current-account";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import { invalidRequest, invalidRouteIdentifier, sharedNetResponse } from "../../../route-response";

type AliasRouteContext = { params: Promise<{ instanceId: string }> };

const INSTANCE_ID = /^i_[0-9A-Za-z]{10}$/;

/** An empty name takes the name back off, so the body's `name` may be null. */
async function nameInput(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalidRequest();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalidRequest();
  // The key has to be there: a body without it is a typo, not a request to
  // take the name off, and a typo should not quietly wipe one.
  if (!Object.prototype.hasOwnProperty.call(body, "name")) throw invalidRequest();
  try {
    return parseSeatName((body as { name?: unknown }).name);
  } catch {
    throw invalidRequest();
  }
}

/**
 * Name a seat. Your own seat takes the name it goes by, which everyone in its
 * Rooms sees; anyone else's takes a note only this account sees. The route is
 * the same either way — which one it is follows from whose seat it is.
 */
export function PUT(request: Request, { params }: AliasRouteContext): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireWebMutation(request);
    const { instanceId } = await params;
    if (!INSTANCE_ID.test(instanceId)) throw invalidRouteIdentifier();
    const name = await nameInput(request);
    return getSharedNetServerClient().nameSeat(authUserId, instanceId as never, name);
  });
}
