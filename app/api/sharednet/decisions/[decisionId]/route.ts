import { requireAuthUserId } from "@/src/sharednet/current-account";
import {
  parseDecisionId,
  type DecisionResolution,
} from "@/src/sharednet/contracts";
import { getSharedNetServerClient } from "@/src/sharednet/server-client";

import {
  invalidRequest,
  invalidRouteIdentifier,
  sharedNetResponse,
} from "../../route-response";

type DecisionRouteContext = {
  params: Promise<{ decisionId: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function decisionResolution(request: Request): Promise<DecisionResolution> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalidRequest();
  }

  if (!isRecord(body)) throw invalidRequest();
  if (
    body.outcome !== "approved" &&
    body.outcome !== "denied" &&
    body.outcome !== "answered"
  ) {
    throw invalidRequest();
  }
  if (body.responseText !== undefined && typeof body.responseText !== "string") {
    throw invalidRequest();
  }

  return {
    outcome: body.outcome,
    responseText: body.responseText,
  };
}

export function PATCH(
  request: Request,
  { params }: DecisionRouteContext,
): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireAuthUserId(request.headers);
    const { decisionId: untrustedDecisionId } = await params;
    const decisionId = parseDecisionId(untrustedDecisionId);
    if (decisionId === null) throw invalidRouteIdentifier();
    const resolution = await decisionResolution(request);
    return getSharedNetServerClient().resolveDecision(
      authUserId,
      decisionId,
      resolution,
    );
  });
}
