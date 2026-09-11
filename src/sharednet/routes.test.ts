import { beforeEach, describe, expect, it, vi } from "vitest";

const { authGetSession, sharedNetClient } = vi.hoisted(() => ({
  authGetSession: vi.fn(),
  sharedNetClient: {
    claimPairing: vi.fn(),
    createRoom: vi.fn(),
    createRoomInvite: vi.fn(),
    revokeRoomInvite: vi.fn(),
    setInstanceAlias: vi.fn(),
    shareRoom: vi.fn(),
    unshareRoom: vi.fn(),
    getSharedRoom: vi.fn(),
    getCredits: vi.fn(),
    redeemCredits: vi.fn(),
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
  resolveTrustedOrigins: () => [],
}));
vi.mock("./server-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-client")>();
  return {
    ...actual,
    getSharedNetServerClient: () => sharedNetClient,
  };
});

import { POST as bootstrapAccount } from "../../app/api/sharednet/bootstrap/route";
import { GET as getCredits } from "../../app/api/sharednet/credits/route";
import { POST as redeemCredits } from "../../app/api/sharednet/credits/redeem/route";
import { GET as listRooms, POST as scheduleRoom } from "../../app/api/sharednet/rooms/route";
import { GET as getRoom } from "../../app/api/sharednet/rooms/[roomId]/route";
import { POST as mintInvite } from "../../app/api/sharednet/rooms/[roomId]/invites/route";
import { DELETE as revokeInvite } from "../../app/api/sharednet/rooms/[roomId]/invites/[inviteId]/route";
import { DELETE as unshareRoom, POST as shareRoom } from "../../app/api/sharednet/rooms/[roomId]/share/route";
import { GET as readSharedRoom } from "../../app/api/sharednet/shared/[token]/route";
import { PUT as nameSeat } from "../../app/api/sharednet/instances/[instanceId]/alias/route";
import { GET as getNetwork } from "../../app/api/sharednet/network/route";
import { GET as listDecisions } from "../../app/api/sharednet/decisions/route";
import { PATCH as resolveDecision } from "../../app/api/sharednet/decisions/[decisionId]/route";
import { POST as claimPairing } from "../../app/api/sharednet/pairings/[pairingId]/claim/route";
import { SharedNetApiError } from "./server-client";
import { isCreditsProjection, isRedeemCreditsResponse } from "./contracts";

const AUTH_USER_ID = "auth-user-1";
const PRINCIPAL_ID = "p_7CPHtWFsFn";
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
};

function request(
  body?: unknown,
  method = "POST",
  path = "/api/sharednet",
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    cookie: "better-auth.session_token=test",
    // What a browser sends from our own page on every non-safe request.
    origin: "http://localhost",
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
      origin: "http://localhost",
    },
    method,
  });
}

function expectNoBackendCall(): void {
  for (const method of Object.values(sharedNetClient)) {
    expect(method).not.toHaveBeenCalled();
  }
}

describe("credits Dashboard routes", () => {
  const credits = { principal_id: PRINCIPAL_ID, balance: 0, granted: 0, sent: 0, received: 0, transfers: [] };

  beforeEach(() => {
    authGetSession.mockReset();
    authGetSession.mockResolvedValue({ user: { id: AUTH_USER_ID } });
    for (const method of Object.values(sharedNetClient)) method.mockReset();
  });

  it.each([
    { name: "read", invoke: () => getCredits(request(undefined, "GET", "/api/sharednet/credits")) },
    { name: "redeem", invoke: () => redeemCredits(rawRequest("{not-json", "POST", "/api/sharednet/credits/redeem")) },
  ])("refuses an unauthenticated credits $name before reading input or calling the domain", async ({ invoke }) => {
    authGetSession.mockResolvedValue(null);
    const response = await invoke();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expectNoBackendCall();
  });

  it("reads only the signed-in account's credits even when the URL names another Principal", async () => {
    sharedNetClient.getCredits.mockResolvedValue(credits);
    const response = await getCredits(new Request("http://localhost/api/sharednet/credits?principal_id=p_V80npHhNlU", {
      headers: { cookie: "better-auth.session_token=test" },
    }));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(isCreditsProjection(body)).toBe(true);
    expect(body).toEqual(credits);
    expect(sharedNetClient.getCredits).toHaveBeenCalledExactlyOnceWith(AUTH_USER_ID);
  });

  it.each(["https://evil.example", null])("refuses credit redemption with Origin %s before reading the session", async (origin) => {
    const headers = new Headers({ "content-type": "application/json", cookie: "better-auth.session_token=test" });
    if (origin !== null) headers.set("origin", origin);
    const response = await redeemCredits(new Request("http://localhost/api/sharednet/credits/redeem", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "BFF-100" }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden_origin" } });
    expect(authGetSession).not.toHaveBeenCalled();
    expectNoBackendCall();
  });

  it("redeems a normalized code for the signed-in account and returns the updated credit projection", async () => {
    const redeemed = {
      granted: 100,
      credits: {
        ...credits,
        balance: 100,
        granted: 100,
        transfers: [{
          transfer_id: "txn_AbCdEfGhIj",
          direction: "granted",
          counterparty: null,
          addressed_to: null,
          amount: 100,
          by_instance_id: null,
          code: "BFF-100",
          memo: null,
          room_id: null,
          created_at: "2026-09-08T07:00:00.000Z",
        }],
      },
    };
    sharedNetClient.redeemCredits.mockResolvedValue(redeemed);
    const response = await redeemCredits(request({ code: " bff-100 " }, "POST", "/api/sharednet/credits/redeem?principal_id=p_V80npHhNlU"));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(isRedeemCreditsResponse(body)).toBe(true);
    expect(body).toEqual(redeemed);
    expect(sharedNetClient.redeemCredits).toHaveBeenCalledExactlyOnceWith(AUTH_USER_ID, "BFF-100");
  });

  it.each([
    { name: "invalid JSON", body: "{not-json" },
    { name: "an invalid code", body: JSON.stringify({ code: "!" }) },
    { name: "a forged recipient", body: JSON.stringify({ code: "BFF-100", principal_id: "p_V80npHhNlU" }) },
  ])("refuses a credit redemption containing $name before the domain can grant anything", async ({ body }) => {
    const response = await redeemCredits(rawRequest(body, "POST", "/api/sharednet/credits/redeem"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expectNoBackendCall();
  });

  it("preserves the credit code refusal without exposing internal details", async () => {
    sharedNetClient.redeemCredits.mockRejectedValue(new SharedNetApiError("credit_code_exhausted", 410, "internal grant details"));
    const response = await redeemCredits(request({ code: "BFF-100" }, "POST", "/api/sharednet/credits/redeem"));

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: { code: "credit_code_exhausted", message: "SharedNet request failed" } });
  });
});

describe("the Web mutation boundary on the Dashboard routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authGetSession.mockResolvedValue({ user: { id: AUTH_USER_ID } });
  });

  it("refuses a mutation that names another page, before the session is read and before any backend call", async () => {
    const foreign = new Request("http://localhost/api/sharednet/rooms", {
      body: JSON.stringify({ name: "Not ours" }),
      headers: { "content-type": "application/json", cookie: "better-auth.session_token=test", origin: "https://evil.example" },
      method: "POST",
    });
    const response = await scheduleRoom(foreign);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden_origin" } });
    expect(authGetSession).not.toHaveBeenCalled();
    expectNoBackendCall();
  });

  it("refuses a mutation with no Origin at all, the shape of a forged form post or a script outside a browser", async () => {
    const bare = new Request("http://localhost/api/sharednet/bootstrap", {
      headers: { cookie: "better-auth.session_token=test" },
      method: "POST",
    });
    const response = await bootstrapAccount(bare);
    expect(response.status).toBe(403);
    expectNoBackendCall();
  });

  it("leaves reads unguarded by origin: a GET with no Origin still answers", async () => {
    sharedNetClient.listRooms.mockResolvedValue({ rooms: [] });
    const response = await listRooms(new Request("http://localhost/api/sharednet/rooms", { headers: { cookie: "better-auth.session_token=test" } }));
    expect(response.status).toBe(200);
  });
});

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
            "/api/sharednet/rooms?principalId=p_ww7tGenO2m",
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
            "/api/sharednet/decisions?agentId=a_Rv1ov75Ma8",
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
            "/api/sharednet/pairings/pairing_1/claim?principalId=p_ww7tGenO2m",
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
        agentId: "a_Rv1ov75Ma8",
        instanceId: "i_Qi6RVkZATU",
        outcome: "approved",
        principalId: "p_ww7tGenO2m",
        runtimeId: "rt_wapy580nh3zst2d6nw98vr6r42",
      },
      expectedResolution: { outcome: "approved", responseText: undefined },
      name: "without response text",
    },
    {
      body: {
        outcome: "answered",
        principalId: "p_ww7tGenO2m",
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

  it("schedules a Room for the signed-in account", async () => {
    const summary = { room_id: "rom_sched00001", name: "Launch review" };
    sharedNetClient.createRoom.mockResolvedValue(summary);

    const response = await scheduleRoom(
      request({ description: null, name: "Launch review" }, "POST", "/api/sharednet/rooms"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(summary);
    expect(sharedNetClient.createRoom).toHaveBeenCalledWith(AUTH_USER_ID, {
      description: null,
      name: "Launch review",
    });
  });

  it.each([
    { body: "{not-json", name: "malformed JSON" },
    { body: JSON.stringify({ description: "no name" }), name: "a missing name" },
    { body: JSON.stringify({ name: 42 }), name: "a non-string name" },
    { body: JSON.stringify({ description: 7, name: "x" }), name: "a non-string description" },
    { body: JSON.stringify(["x"]), name: "a non-object body" },
  ])("returns 400 when scheduling a Room with $name", async ({ body }) => {
    const response = await scheduleRoom(rawRequest(body, "POST", "/api/sharednet/rooms"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expectNoBackendCall();
  });

  it("mints a Room invite for the signed-in account and returns the token once", async () => {
    const minted = { invite: { invite_id: "inv_0000000001", room_id: "rom_lxw0rfaLIb" }, token: "rit_x" };
    sharedNetClient.createRoomInvite.mockResolvedValue(minted);

    const response = await mintInvite(
      rawRequest("", "POST", "/api/sharednet/rooms/rom_lxw0rfaLIb/invites"),
      { params: Promise.resolve({ roomId: "rom_lxw0rfaLIb" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(minted);
    expect(sharedNetClient.createRoomInvite).toHaveBeenCalledWith(AUTH_USER_ID, "rom_lxw0rfaLIb", {});
  });

  it("passes an explicit invite expiry through and rejects a malformed one", async () => {
    sharedNetClient.createRoomInvite.mockResolvedValue({ invite: {}, token: "rit_x" });
    await mintInvite(
      request({ expires_in_seconds: 3600 }, "POST", "/api/sharednet/rooms/rom_lxw0rfaLIb/invites"),
      { params: Promise.resolve({ roomId: "rom_lxw0rfaLIb" }) },
    );
    expect(sharedNetClient.createRoomInvite).toHaveBeenLastCalledWith(AUTH_USER_ID, "rom_lxw0rfaLIb", {
      expires_in_seconds: 3600,
    });

    const bad = await mintInvite(
      request({ expires_in_seconds: "soon" }, "POST", "/api/sharednet/rooms/rom_lxw0rfaLIb/invites"),
      { params: Promise.resolve({ roomId: "rom_lxw0rfaLIb" }) },
    );
    expect(bad.status).toBe(400);
  });

  it("refuses to mint an invite without a session or for a malformed Room id", async () => {
    const malformed = await mintInvite(
      rawRequest("", "POST", "/api/sharednet/rooms/room%2Fforged/invites"),
      { params: Promise.resolve({ roomId: "room/forged" }) },
    );
    expect(await malformed.json()).toEqual({
      error: { code: "invalid_route_id", message: "Invalid route identifier" },
    });
    expect(malformed.status).toBe(400);

    authGetSession.mockResolvedValue(null);
    const anonymous = await mintInvite(
      rawRequest("", "POST", "/api/sharednet/rooms/rom_lxw0rfaLIb/invites"),
      { params: Promise.resolve({ roomId: "rom_lxw0rfaLIb" }) },
    );
    expect(anonymous.status).toBe(401);
    expect(sharedNetClient.createRoomInvite).not.toHaveBeenCalled();
  });

  it("revokes an invite by id and rejects a malformed invite id", async () => {
    sharedNetClient.revokeRoomInvite.mockResolvedValue({ invite: { invite_id: "inv_0000000001" } });
    const response = await revokeInvite(
      rawRequest("", "DELETE", "/api/sharednet/rooms/rom_lxw0rfaLIb/invites/inv_0000000001"),
      { params: Promise.resolve({ inviteId: "inv_0000000001", roomId: "rom_lxw0rfaLIb" }) },
    );
    expect(response.status).toBe(200);
    expect(sharedNetClient.revokeRoomInvite).toHaveBeenCalledWith(
      AUTH_USER_ID,
      "rom_lxw0rfaLIb",
      "inv_0000000001",
    );

    const malformed = await revokeInvite(
      rawRequest("", "DELETE", "/api/sharednet/rooms/rom_lxw0rfaLIb/invites/nope"),
      { params: Promise.resolve({ inviteId: "nope", roomId: "rom_lxw0rfaLIb" }) },
    );
    expect(malformed.status).toBe(400);
  });

  it("refuses to schedule a Room without a session", async () => {
    authGetSession.mockResolvedValue(null);

    const response = await scheduleRoom(
      request({ name: "Launch review" }, "POST", "/api/sharednet/rooms"),
    );

    expect(response.status).toBe(401);
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

describe("sharing a Room: the owner's mutation, and the one route with nobody behind it", () => {
  const SLUG = `shr_${"s".repeat(43)}`;

  beforeEach(() => {
    vi.clearAllMocks();
    authGetSession.mockResolvedValue({ user: { id: AUTH_USER_ID } });
  });

  it("publishes and unpublishes a Room for the signed-in account, from our own page only", async () => {
    sharedNetClient.shareRoom.mockResolvedValue({ room: { room_id: "rom_lxw0rfaLIb" }, token: SLUG });
    const published = await shareRoom(rawRequest("", "POST", "/api/sharednet/rooms/rom_lxw0rfaLIb/share"), {
      params: Promise.resolve({ roomId: "rom_lxw0rfaLIb" }),
    });
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({ room: { room_id: "rom_lxw0rfaLIb" }, token: SLUG });
    expect(sharedNetClient.shareRoom).toHaveBeenCalledWith(AUTH_USER_ID, "rom_lxw0rfaLIb");

    sharedNetClient.unshareRoom.mockResolvedValue({ room: { room_id: "rom_lxw0rfaLIb" } });
    const stopped = await unshareRoom(rawRequest("", "DELETE", "/api/sharednet/rooms/rom_lxw0rfaLIb/share"), {
      params: Promise.resolve({ roomId: "rom_lxw0rfaLIb" }),
    });
    expect(stopped.status).toBe(200);
    expect(sharedNetClient.unshareRoom).toHaveBeenCalledWith(AUTH_USER_ID, "rom_lxw0rfaLIb");

    const foreign = new Request("http://localhost/api/sharednet/rooms/rom_lxw0rfaLIb/share", {
      headers: { cookie: "better-auth.session_token=test", origin: "https://evil.example" },
      method: "POST",
    });
    expect((await shareRoom(foreign, { params: Promise.resolve({ roomId: "rom_lxw0rfaLIb" }) })).status).toBe(403);
    authGetSession.mockResolvedValue(null);
    expect((await shareRoom(rawRequest("", "POST", "/api/sharednet/rooms/rom_lxw0rfaLIb/share"), { params: Promise.resolve({ roomId: "rom_lxw0rfaLIb" }) })).status).toBe(401);
    expect(sharedNetClient.shareRoom).toHaveBeenCalledTimes(1);
  });

  it("serves a shared Room to anyone, by its slug alone, and refuses anything that is not a slug before touching the domain", async () => {
    authGetSession.mockResolvedValue(null);
    const shared = { room: { name: "Launch" }, members: [], messages: [] };
    sharedNetClient.getSharedRoom.mockResolvedValue(shared);

    const anonymous = new Request(`http://localhost/api/sharednet/shared/${SLUG}`);
    const response = await readSharedRoom(anonymous, { params: Promise.resolve({ token: SLUG }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(shared);
    expect(sharedNetClient.getSharedRoom).toHaveBeenCalledWith(SLUG);
    expect(authGetSession).not.toHaveBeenCalled();

    for (const notASlug of ["rom_lxw0rfaLIb", `rit_${"t".repeat(43)}`, "shr_short", ""]) {
      const refused = await readSharedRoom(new Request("http://localhost/api/sharednet/shared/x"), { params: Promise.resolve({ token: notASlug }) });
      expect(refused.status).toBe(400);
    }
    expect(sharedNetClient.getSharedRoom).toHaveBeenCalledTimes(1);

    sharedNetClient.getSharedRoom.mockRejectedValue(new SharedNetApiError("room_not_found", 404, "Room was not found."));
    const gone = await readSharedRoom(anonymous, { params: Promise.resolve({ token: SLUG }) });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: "room_not_found" } });
  });
});

describe("naming a seat, for this account's eyes only", () => {
  const INSTANCE = "i_xQqH1Bafyt";

  beforeEach(() => {
    vi.clearAllMocks();
    authGetSession.mockResolvedValue({ user: { id: AUTH_USER_ID } });
  });

  it("puts the name through for the signed-in account, from our own page only", async () => {
    sharedNetClient.setInstanceAlias.mockResolvedValue({ alias: "Kai", instance_id: INSTANCE });

    const named = await nameSeat(request({ alias: "  Kai  " }, "PUT", `/api/sharednet/instances/${INSTANCE}/alias`), {
      params: Promise.resolve({ instanceId: INSTANCE }),
    });
    expect(named.status).toBe(200);
    expect(await named.json()).toEqual({ alias: "Kai", instance_id: INSTANCE });
    // The protocol trims and normalises before the domain ever sees it.
    expect(sharedNetClient.setInstanceAlias).toHaveBeenCalledWith(AUTH_USER_ID, INSTANCE, "Kai");

    // An empty name is how one is taken back off.
    sharedNetClient.setInstanceAlias.mockResolvedValue({ alias: null, instance_id: INSTANCE });
    await nameSeat(request({ alias: "" }, "PUT", `/api/sharednet/instances/${INSTANCE}/alias`), {
      params: Promise.resolve({ instanceId: INSTANCE }),
    });
    expect(sharedNetClient.setInstanceAlias).toHaveBeenLastCalledWith(AUTH_USER_ID, INSTANCE, null);

    const foreign = new Request(`http://localhost/api/sharednet/instances/${INSTANCE}/alias`, {
      body: JSON.stringify({ alias: "Kai" }),
      headers: { "content-type": "application/json", cookie: "better-auth.session_token=test", origin: "https://evil.example" },
      method: "PUT",
    });
    expect((await nameSeat(foreign, { params: Promise.resolve({ instanceId: INSTANCE }) })).status).toBe(403);

    authGetSession.mockResolvedValue(null);
    const signedOut = await nameSeat(request({ alias: "Kai" }, "PUT", `/api/sharednet/instances/${INSTANCE}/alias`), {
      params: Promise.resolve({ instanceId: INSTANCE }),
    });
    expect(signedOut.status).toBe(401);
    expect(sharedNetClient.setInstanceAlias).toHaveBeenCalledTimes(2);
  });

  it("refuses a name that is not one, and an id that is not an Instance, before the domain is asked", async () => {
    for (const body of [{ alias: "x".repeat(49) }, { alias: "line\nbreak" }, { alias: 7 }, { notAlias: "Kai" }]) {
      const refused = await nameSeat(request(body, "PUT", `/api/sharednet/instances/${INSTANCE}/alias`), {
        params: Promise.resolve({ instanceId: INSTANCE }),
      });
      expect(refused.status).toBe(400);
    }
    for (const id of ["p_7CPHtWFsFn", "i_short", "../../etc"]) {
      const refused = await nameSeat(request({ alias: "Kai" }, "PUT", "/api/sharednet/instances/x/alias"), {
        params: Promise.resolve({ instanceId: id }),
      });
      expect(refused.status).toBe(400);
    }
    expect(sharedNetClient.setInstanceAlias).not.toHaveBeenCalled();
  });
});

