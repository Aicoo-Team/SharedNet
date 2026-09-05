import { requireAuthUserId } from "@/src/sharednet/current-account";
import {
  type CreateRoomInput,
  getSharedNetServerClient,
} from "@/src/sharednet/server-client";

import { invalidRequest, sharedNetResponse } from "../route-response";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Web schedules an empty Room: a name, optionally what it is for. */
async function createRoomInput(request: Request): Promise<CreateRoomInput> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalidRequest();
  }

  if (!isRecord(body)) throw invalidRequest();
  if (typeof body.name !== "string") throw invalidRequest();
  if (
    body.description !== undefined &&
    body.description !== null &&
    typeof body.description !== "string"
  ) {
    throw invalidRequest();
  }

  return { description: body.description ?? null, name: body.name };
}

export function GET(request: Request): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireAuthUserId(request.headers);
    return getSharedNetServerClient().listRooms(authUserId);
  });
}

export function POST(request: Request): Promise<Response> {
  return sharedNetResponse(async () => {
    const authUserId = await requireAuthUserId(request.headers);
    const input = await createRoomInput(request);
    return getSharedNetServerClient().createRoom(authUserId, input);
  });
}
