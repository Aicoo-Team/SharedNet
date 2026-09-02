import { requireAuthUserId } from "@/src/sharednet/current-account";
import { parsePairingId } from "@/src/sharednet/contracts";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import {
  invalidRouteIdentifier,
  sharedNetResponse,
} from "../../../route-response";

type PairingRouteContext = {
  params: Promise<{ pairingId: string }>;
};

export function POST(
  request: Request,
  { params }: PairingRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireAuthUserId(request.headers);
    const { pairingId: untrustedPairingId } = await params;
    const pairingId = parsePairingId(untrustedPairingId);
    if (pairingId === null) throw invalidRouteIdentifier();
    return getSharedNetServerClient().claimPairing(authUserId, pairingId);
  });
}
