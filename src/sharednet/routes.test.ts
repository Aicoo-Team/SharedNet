import { beforeEach, describe, expect, it, vi } from "vitest";

const { authGetSession, sharedNetClient } = vi.hoisted(() => ({
  authGetSession: vi.fn(),
  sharedNetClient: {
    claimPairing: vi.fn(),
    getNetwork: vi.fn(),
    getRoom: vi.fn(),
    listDecisions: vi.fn(),
    listRooms: vi.fn(),
    provisionAccount: vi.fn(),
    resolveDecision: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("../../lib/auth", () => ({
  getAuth: () => ({ api: { getSession: authGetSession } }),
}));
vi.mock("./server-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-client")>();
  return {
    ...actual,
    getSharedNetServerClient: () => sharedNetClient,
  };
});

import { POST as bootstrapAccount } from "../../app/api/sharednet/bootstrap/route";
import { GET as listRooms } from "../../app/api/sharednet/rooms/route";
import { GET as getRoom } from "../../app/api/sharednet/rooms/[roomId]/route";
import { GET as getNetwork } from "../../app/api/sharednet/network/route";
import { GET as listDecisions } from "../../app/api/sharednet/decisions/route";
import { PATCH as resolveDecision } from "../../app/api/sharednet/decisions/[decisionId]/route";
import { POST as claimPairing } from "../../app/api/sharednet/pairings/[pairingId]/claim/route";
import { SharedNetApiError } from "./server-client";

const AUTH_USER_ID = "auth-user-1";
const PRINCIPAL_ID = "pri_w7ytve6398hy7gmjsk1c9q78hb";
const DECISION = {
  decision_id: "decision_1",
  response_text: null,
  status: "pending",
};
const ROOM_DETAIL = {
  memberships: [],
  messages: [],
  next_cursor: "cursor_0",
  room: { room_id: "room_1" },
};
const NETWORK = {
  agents: [],
  connected_principals: [],
  edges: [],
  instances: [],
  principal: { principal_id: PRINCIPAL_ID },
  runtimes: [],
};

function request(
  body?: unknown,
  method = "POST",
  path = "/api/sharednet",
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    cookie: "better-auth.session_token=test",
  });
  return new Request(`http://localhost${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
  });
}

function rawRequest(
  body: string,
  method = "POST",
  path = "/api/sharednet",
): Request {
  return new Request(`http://localhost${path}`, {
    body,
    headers: {
      "content-type": "application/json",
      cookie: "better-auth.session_token=test",
    },
    method,
  });
}

function expectNoBackendCall(): void {
  for (const method of Object.values(sharedNetClient)) {
    expect(method).not.toHaveBeenCalled();
  }
}

describe("authenticated SharedNet Dashboard routes", () => {
  beforeEach(() => {
    authGetSession.mockReset();
    authGetSession.mockResolvedValue({ user: { id: AUTH_USER_ID } });
    for (const method of Object.values(sharedNetClient)) {
      method.mockReset();
    }
  });

  it.each([
    {
      invoke: () =>
        bootstrapAccount(rawRequest("{not-json", "POST", "/api/sharednet/bootstrap")),
      name: "bootstrap",
    },
    {
      invoke: () => listRooms(request(undefined, "GET", "/api/sharednet/rooms")),
      name: "room list",
    },
    {
      invoke: () =>
        getRoom(request(undefined, "GET", "/api/sharednet/rooms/%2F"), {
          params: Promise.resolve({ roomId: "room/forged" }),
        }),
      name: "room detail",
    },
    {
      invoke: () => listDecisions(request(undefined, "GET", "/api/sharednet/decisions")),
      name: "decision list",
    },
    {
      invoke: () =>
        resolveDecision(
          rawRequest("{not-json", "PATCH", "/api/sharednet/decisions/%2F"),
          { params: Promise.resolve({ decisionId: "decision/forged" }) },
        ),
      name: "decision resolution",
    },
    {
      invoke: () => getNetwork(request(undefined, "GET", "/api/sharednet/network")),
      name: "network",
    },
    {
      invoke: () =>
        claimPairing(
          rawRequest("{not-json", "POST", "/api/sharednet/pairings/%2F/claim"),
          { params: Promise.resolve({ pairingId: "pairing/forged" }) },
        ),
      name: "pairing claim",
    },
  ])("returns 401 before consuming unauthenticated $name input", async ({ invoke }) => {
    authGetSession.mockResolvedValue(null);

    const response = await invoke();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Authentication required" },
    });
    expectNoBackendCall();
  });

  it.each([
    {
      expectedArgs: [AUTH_USER_ID],
      invoke: () =>
        bootstrapAccount(rawRequest("{not-json", "POST", "/api/sharednet/bootstrap")),
      method: sharedNetClient.provisionAccount,
      name: "bootstrap",
      result: { principal_id: PRINCIPAL_ID },
    },
    {
      expectedArgs: [AUTH_USER_ID],
      invoke: () =>
        listRooms(
          request(
            undefined,
            "GET",
            "/api/sharednet/rooms?principalId=pri_apszmrq9c8v09wg5pa6btzk1w7",
          ),
        ),
      method: sharedNetClient.listRooms,
      name: "room list",
      result: { rooms: [] },
    },
    {
      expectedArgs: [AUTH_USER_ID, "room_1"],
      invoke: () =>
        getRoom(request(undefined, "GET", "/api/sharednet/rooms/room_1"), {
          params: Promise.resolve({ roomId: "room_1" }),
        }),
      method: sharedNetClient.getRoom,
      name: "room detail",
      result: ROOM_DETAIL,
    },
    {
      expectedArgs: [AUTH_USER_ID],
      invoke: () =>
        getNetwork(
          request(
            undefined,
            "GET",
            "/api/sharednet/network?runtimeId=rt_wapy580nh3zst2d6nw98vr6r42",
          ),
        ),
      method: sharedNetClient.getNetwork,
      name: "network",
      result: NETWORK,
    },
    {
      expectedArgs: [AUTH_USER_ID],
      invoke: () =>
        listDecisions(
          request(
            undefined,
            "GET",
            "/api/sharednet/decisions?agentId=agt_g2fraebny9xajpc0evtcwf501c",
          ),
        ),
      method: sharedNetClient.listDecisions,
      name: "decision list",
      result: { decisions: [] },
    },
    {
      expectedArgs: [AUTH_USER_ID, "pairing_1"],
      invoke: () =>
        claimPairing(
          rawRequest(
            "{not-json",
            "POST",
            "/api/sharednet/pairings/pairing_1/claim?principalId=pri_apszmrq9c8v09wg5pa6btzk1w7",
          ),
          { params: Promise.resolve({ pairingId: "pairing_1" }) },
        ),
      method: sharedNetClient.claimPairing,
      name: "pairing claim",
      result: DECISION,
    },
  ])(
    "scopes the $name route to the Better Auth user",
    async ({ expectedArgs, invoke, method, result }) => {
      method.mockResolvedValue(result);

      const response = await invoke();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
      expect(method).toHaveBeenCalledWith(...expectedArgs);
    },
  );

  it.each([
    {
      body: {
        agentId: "agt_g2fraebny9xajpc0evtcwf501c",
        instanceId: "ins_hjxe2fgyw5m6wgjxyqs8qerr7p",
        outcome: "approved",
        principalId: "pri_apszmrq9c8v09wg5pa6btzk1w7",
        runtimeId: "rt_wapy580nh3zst2d6nw98vr6r42",
      },
      expectedResolution: { outcome: "approved", responseText: undefined },
      name: "without response text",
    },
    {
      body: {
        outcome: "answered",
        principalId: "pri_apszmrq9c8v09wg5pa6btzk1w7",
        responseText: "Singapore",
      },
      expectedResolution: { outcome: "answered", responseText: "Singapore" },
      name: "with response text",
    },
  ])(
    "ignores forged identity fields while resolving a decision $name",
    async ({ body, expectedResolution }) => {
      sharedNetClient.resolveDecision.mockResolvedValue(DECISION);

      const response = await resolveDecision(
        request(body, "PATCH", "/api/sharednet/decisions/decision_1"),
        { params: Promise.resolve({ decisionId: "decision_1" }) },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(DECISION);
      expect(sharedNetClient.resolveDecision).toHaveBeenCalledWith(
        AUTH_USER_ID,
        "decision_1",
        expectedResolution,
      );
    },
  );

  it.each([
    { body: {}, name: "a missing outcome" },
    { body: { outcome: "pending" }, name: "an unsupported outcome" },
    {
      body: { outcome: "answered", responseText: 42 },
      name: "a non-string responseText",
    },
    { body: null, name: "a null body" },
  ])("returns 400 for $name", async ({ body }) => {
    const response = await resolveDecision(
      request(body, "PATCH", "/api/sharednet/decisions/decision_1"),
      { params: Promise.resolve({ decisionId: "decision_1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expectNoBackendCall();
  });

  it("returns 400 for malformed decision JSON", async () => {
    const response = await resolveDecision(
      rawRequest("{not-json", "PATCH", "/api/sharednet/decisions/decision_1"),
      { params: Promise.resolve({ decisionId: "decision_1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expectNoBackendCall();
  });

  it.each([
    {
      invoke: () =>
        getRoom(request(undefined, "GET", "/api/sharednet/rooms/%2F"), {
          params: Promise.resolve({ roomId: "room/forged" }),
        }),
      name: "room",
    },
    {
      invoke: () =>
        resolveDecision(
          request(
            { outcome: "approved" },
            "PATCH",
            "/api/sharednet/decisions/%2F",
          ),
          { params: Promise.resolve({ decisionId: "decision/forged" }) },
        ),
      name: "decision",
    },
    {
      invoke: () =>
        claimPairing(
          request(undefined, "POST", "/api/sharednet/pairings/%2F/claim"),
          { params: Promise.resolve({ pairingId: "pairing/forged" }) },
        ),
      name: "pairing",
    },
  ])("validates the $name route ID with the Task 3 parser", async ({ invoke }) => {
    const response = await invoke();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_route_id", message: "Invalid route identifier" },
    });
    expectNoBackendCall();
  });

  it("preserves a safe backend 404 status and code without serializing details", async () => {
    sharedNetClient.getRoom.mockRejectedValue(
      new SharedNetApiError(
        "room_not_found",
        404,
        "Room missing; console token is console-secret",
      ),
    );

    const response = await getRoom(
      request(undefined, "GET", "/api/sharednet/rooms/room_1"),
      { params: Promise.resolve({ roomId: "room_1" }) },
    );
    const serialized = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(serialized)).toEqual({
      error: { code: "room_not_found", message: "SharedNet request failed" },
    });
    expect(serialized).not.toContain("console-secret");
    expect(serialized).not.toContain("console token");
  });

  it("normalizes unsafe backend status and code", async () => {
    sharedNetClient.listRooms.mockRejectedValue(
      new SharedNetApiError(
        "unsafe code: console-secret",
        302,
        "http://internal.example/console-secret",
      ),
    );

    const response = await listRooms(
      request(undefined, "GET", "/api/sharednet/rooms"),
    );
    const serialized = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(serialized)).toEqual({
      error: { code: "sharednet_api_error", message: "SharedNet request failed" },
    });
    expect(serialized).not.toContain("console-secret");
    expect(serialized).not.toContain("internal.example");
  });

  it("never serializes an unexpected internal error or secret fields", async () => {
    sharedNetClient.listDecisions.mockRejectedValue(
      Object.assign(
        new Error("SHAREDNET_CONSOLE_TOKEN=console-secret at /internal/path"),
        { connector_token: "console-secret", internalState: { password: "secret" } },
      ),
    );

    const response = await listDecisions(
      request(undefined, "GET", "/api/sharednet/decisions"),
    );
    const serialized = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(serialized)).toEqual({
      error: { code: "internal_error", message: "SharedNet request failed" },
    });
    expect(serialized).not.toContain("console-secret");
    expect(serialized).not.toContain("connector_token");
    expect(serialized).not.toContain("internalState");
    expect(serialized).not.toContain("/internal/path");
  });
});
