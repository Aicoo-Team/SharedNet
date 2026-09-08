import { requireWebMutation } from "@/src/sharednet/current-account";
import { parseRoomId } from "@/src/sharednet/contracts";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import {
  invalidRequest,
  invalidRouteIdentifier,
  sharedNetResponse,
} from "../../../route-response";

type InviteRouteContext = {
  params: Promise<{ roomId: string }>;
};

/** An empty body mints a standing invite; `expires_in_seconds` is opt-in. */
async function inviteInput(request: Request): Promise<{ expires_in_seconds?: number | null }> {
  const text = await request.text();
  if (text.length === 0) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalidRequest();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalidRequest();
  const { expires_in_seconds: seconds } = body as Record<string, unknown>;
  if (seconds !== undefined && seconds !== null && typeof seconds !== "number") {
    throw invalidRequest();
  }
  return { expires_in_seconds: (seconds as number | null | undefined) ?? null };
}

/** Mint a Room invite token for a Room this account owns. The token is returned once. */
export function POST(
  request: Request,
  { params }: InviteRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireWebMutation(request);
    const { roomId: untrustedRoomId } = await params;
    const roomId = parseRoomId(untrustedRoomId);
    if (roomId === null) throw invalidRouteIdentifier();
    const input = await inviteInput(request);
    return getSharedNetServerClient().createRoomInvite(authUserId, roomId, input);
  });
}
