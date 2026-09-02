import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import {
  getSharedNetServerClient,
  SharedNetApiError,
  type SharedNetServerClient,
} from "./server-client";
import {
  isRoomMessage,
  parseDecisionId,
  parsePairingId,
  parseRoomId,
  type DecisionId,
  type PairingId,
  type RoomId,
} from "./contracts";

const NOW = "2026-09-03T05:00:00+00:00";
const PRINCIPAL_ID = "p_15COsXY9aK";
const AGENT_ID = "a_7Qm2Zx8WpL";
const RUNTIME_ID = "r_4Nk8Vm2QaT";
const INSTANCE_ID = "i_8pQ2Km7XaN";
const PAIRING_ID = parsePairingId("pairing_launch")!;
const ROOM_ID = parseRoomId("room_planning")!;
const DECISION_ID = parseDecisionId("decision_region")!;
const PAIRING_PATH_ID = parsePairingId("pairing.launch:1")!;
const ROOM_PATH_ID = parseRoomId("room.launch:1")!;
const DECISION_PATH_ID = parseDecisionId("decision.launch:1")!;

const actor = {
  agent_id: AGENT_ID,
  instance_id: INSTANCE_ID,
  principal_id: PRINCIPAL_ID,
  runtime_id: RUNTIME_ID,
};

const decision = {
  consequence: null,
  created_at: NOW,
  decision_id: DECISION_ID,
  description: "Choose one deployment region",
  requester: actor,
  resolved_at: null,
  response_mode: "text",
  response_text: null,
  room_id: ROOM_ID,
  status: "pending",
  target_principal_id: PRINCIPAL_ID,
  title: "Deployment region",
};

const roomSummary = {
  description: "Coordinate the launch",
  latest_cursor: "cursor_1",
  latest_sequence: 1,
  member_count: 1,
  name: "Launch",
  owner_agent_ids: [AGENT_ID],
  room_id: ROOM_ID,
  status: "open",
  updated_at: NOW,
};

const roomDetail = {
  memberships: [
    {
      agent_id: AGENT_ID,
      joined_at: NOW,
      last_read_sequence: 0,
      left_at: null,
      principal_id: PRINCIPAL_ID,
      room_id: ROOM_ID,
      status: "active",
    },
  ],
  messages: [
    {
      attachment_ids: [],
      content: "Ship the account Dashboard",
      created_at: NOW,
      message_id: "message_launch",
      reply_to: null,
      resolution_state: "not_required",
      room_id: ROOM_ID,
      sender: actor,
      sequence: 1,
      tags: [],
    },
  ],
  next_cursor: "cursor_1",
  room: {
    access_policy: "anyone_with_id",
    created_at: NOW,
    creator: actor,
    description: "Coordinate the launch",
    name: "Launch",
    room_id: ROOM_ID,
    status: "open",
    updated_at: NOW,
  },
};

const network = {
  agents: [
    {
      agent_id: AGENT_ID,
      capabilities: ["rooms", "decisions"],
      created_at: NOW,
      diagnostic_label: "Codex",
      discoverability: false,
      official: false,
      principal_id: PRINCIPAL_ID,
      role: "Agent",
      runtime_kind: "codex",
      summary: "Local coding Agent",
    },
  ],
  connected_principals: [],
  edges: [],
  instances: [
    {
      agent_id: AGENT_ID,
      ended_at: null,
      expires_at: "2026-09-03T05:01:30+00:00",
      instance_id: INSTANCE_ID,
      last_seen_at: NOW,
      presence: "online",
      principal_id: PRINCIPAL_ID,
      runtime_id: RUNTIME_ID,
      runtime_type: "codex",
      started_at: NOW,
      status: "online",
      workspace_label: "/workspace/sharednet",
    },
  ],
  principal: {
    created_at: NOW,
    diagnostic_label: "SharedNet Principal",
    kind: "account",
    principal_id: PRINCIPAL_ID,
    summary: "",
  },
  runtimes: [
    {
      agent_id: AGENT_ID,
      created_at: NOW,
      principal_id: PRINCIPAL_ID,
      runtime_id: RUNTIME_ID,
      runtime_kind: "codex",
      status: "active",
      workspace_label: "/workspace/sharednet",
    },
  ],
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("SharedNetServerClient", () => {
  beforeEach(() => {
    vi.stubEnv("SHAREDNET_API_URL", "http://127.0.0.1:8765");
    vi.stubEnv("SHAREDNET_CONSOLE_TOKEN", "console-test");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps the Console credential on the server request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rooms: [] }));
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);

    await getSharedNetServerClient().listRooms("auth-user-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/v1/console/accounts/auth-user-1/rooms",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-SharedNet-Console-Token": "console-test",
        }),
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("calls every account-scoped endpoint with the exact JSON contract", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ principal_id: PRINCIPAL_ID }))
      .mockResolvedValueOnce(jsonResponse(decision))
      .mockResolvedValueOnce(jsonResponse({ rooms: [roomSummary] }))
      .mockResolvedValueOnce(jsonResponse(roomDetail))
      .mockResolvedValueOnce(jsonResponse(network))
      .mockResolvedValueOnce(jsonResponse({ decisions: [decision] }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...decision,
          resolved_at: NOW,
          response_text: "Singapore",
          status: "answered",
        }),
      );
    const client = getSharedNetServerClient();

    await expect(client.provisionAccount("auth/user 1")).resolves.toEqual({
      principal_id: PRINCIPAL_ID,
    });
    await expect(
      client.claimPairing("auth/user 1", PAIRING_PATH_ID),
    ).resolves.toEqual(decision);
    await expect(client.listRooms("auth/user 1")).resolves.toEqual({
      rooms: [roomSummary],
    });
    await expect(
      client.getRoom("auth/user 1", ROOM_PATH_ID),
    ).resolves.toEqual(roomDetail);
    await expect(client.getNetwork("auth/user 1")).resolves.toEqual(network);
    await expect(client.listDecisions("auth/user 1")).resolves.toEqual({
      decisions: [decision],
    });
    await expect(
      client.resolveDecision("auth/user 1", DECISION_PATH_ID, {
        outcome: "answered",
        responseText: "Singapore",
      }),
    ).resolves.toMatchObject({
      response_text: "Singapore",
      status: "answered",
    });

    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body]),
    ).toEqual([
      [
        "http://127.0.0.1:8765/v1/console/accounts/auth%2Fuser%201/provision",
        "POST",
        undefined,
      ],
      [
        "http://127.0.0.1:8765/v1/console/accounts/auth%2Fuser%201/pairings/pairing.launch%3A1/claim",
        "POST",
        undefined,
      ],
      [
        "http://127.0.0.1:8765/v1/console/accounts/auth%2Fuser%201/rooms",
        "GET",
        undefined,
      ],
      [
        "http://127.0.0.1:8765/v1/console/accounts/auth%2Fuser%201/rooms/room.launch%3A1",
        "GET",
        undefined,
      ],
      [
        "http://127.0.0.1:8765/v1/console/accounts/auth%2Fuser%201/network",
        "GET",
        undefined,
      ],
      [
        "http://127.0.0.1:8765/v1/console/accounts/auth%2Fuser%201/decisions",
        "GET",
        undefined,
      ],
      [
        "http://127.0.0.1:8765/v1/console/accounts/auth%2Fuser%201/decisions/decision.launch%3A1/resolve",
        "POST",
        JSON.stringify({ outcome: "answered", response_text: "Singapore" }),
      ],
    ]);
  });

  it("maps a structured API failure into SharedNetApiError", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: "room_not_found", message: "Room was not found" } },
        404,
      ),
    );

    const error = await getSharedNetServerClient()
      .getRoom("auth-user-1", ROOM_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SharedNetApiError);
    expect(error).toMatchObject({
      code: "room_not_found",
      message: "Room was not found",
      status: 404,
    });
  });

  it("rejects successful payloads containing fields outside the response contract", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ rooms: [], connector_token: "must-not-cross-the-BFF" }),
    );

    await expect(
      getSharedNetServerClient().listRooms("auth-user-1"),
    ).rejects.toMatchObject({
      code: "invalid_sharednet_response",
      status: 502,
    });
  });

  it.each([
    ["provisionAccount", { principal_id: "not-a-principal" }],
    ["claimPairing", { ...decision, requester: { ...actor, instance_id: null } }],
    ["listRooms", { rooms: [{ ...roomSummary, member_count: -1 }] }],
    ["getRoom", { ...roomDetail, next_cursor: "1" }],
    ["getNetwork", { ...network, agents: [{ ...network.agents[0], official: "no" }] }],
    ["listDecisions", { decisions: [{ ...decision, status: "unknown" }] }],
    ["resolveDecision", { ...decision, response_mode: "unknown" }],
  ] as const)("rejects malformed %s responses", async (method, responseBody) => {
    fetchMock.mockResolvedValue(jsonResponse(responseBody));
    const client = getSharedNetServerClient();
    const call = {
      claimPairing: () => client.claimPairing("auth-user-1", PAIRING_ID),
      getNetwork: () => client.getNetwork("auth-user-1"),
      getRoom: () => client.getRoom("auth-user-1", ROOM_ID),
      listDecisions: () => client.listDecisions("auth-user-1"),
      listRooms: () => client.listRooms("auth-user-1"),
      provisionAccount: () => client.provisionAccount("auth-user-1"),
      resolveDecision: () =>
        client.resolveDecision("auth-user-1", DECISION_ID, {
          outcome: "approved",
        }),
    }[method];

    await expect(call()).rejects.toMatchObject({
      code: "invalid_sharednet_response",
      message: "SharedNet API returned an invalid response",
      status: 502,
    });
  });

  it.each(["SHAREDNET_API_URL", "SHAREDNET_CONSOLE_TOKEN"] as const)(
    "fails closed when %s is missing",
    (name) => {
      vi.stubEnv(name, "");

      expect(() => getSharedNetServerClient()).toThrow(
        `${name} must be configured for the SharedNet server client`,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    "ftp://127.0.0.1:8765",
    "http://user:password@127.0.0.1:8765",
    "http://127.0.0.1:8765/v1",
    "http://127.0.0.1:8765/?tenant=one",
    "http://127.0.0.1:8765/#console",
    "not a URL",
  ])("rejects non-origin SharedNet API URL %s", (apiUrl) => {
    vi.stubEnv("SHAREDNET_API_URL", apiUrl);

    expect(() => getSharedNetServerClient()).toThrow(
      "SHAREDNET_API_URL must be an HTTP(S) origin without credentials, path, query, or fragment",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps timeout failures without exposing transport details", async () => {
    fetchMock.mockRejectedValue(
      new DOMException(
        "console-test timed out at http://127.0.0.1:8765",
        "TimeoutError",
      ),
    );

    const error = await getSharedNetServerClient()
      .listRooms("auth-user-1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SharedNetApiError);
    expect(error).toMatchObject({
      code: "sharednet_api_timeout",
      message: "SharedNet API request timed out",
      status: 504,
    });
    expect(String(error)).not.toContain("console-test");
    expect(String(error)).not.toContain("127.0.0.1");
  });

  it("maps other transport failures without exposing transport details", async () => {
    fetchMock.mockRejectedValue(
      new TypeError(
        "fetch failed for console-test at http://127.0.0.1:8765",
      ),
    );

    const error = await getSharedNetServerClient()
      .listRooms("auth-user-1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SharedNetApiError);
    expect(error).toMatchObject({
      code: "sharednet_api_unavailable",
      message: "SharedNet API is unavailable",
      status: 502,
    });
    expect(String(error)).not.toContain("console-test");
    expect(String(error)).not.toContain("127.0.0.1");
  });
});

describe("untrusted route ID parsers", () => {
  it.each([
    ["pairing", parsePairingId, "pairing_demo"],
    ["room", parseRoomId, "room.demo:one"],
    ["decision", parseDecisionId, "decision-demo_1"],
  ] as const)("brands a valid %s ID", (_kind, parse, value) => {
    expect(parse(value)).toBe(value);
  });

  it.each([parsePairingId, parseRoomId, parseDecisionId])(
    "rejects malformed untrusted route IDs",
    (parse) => {
      expect(parse(undefined)).toBeNull();
      expect(parse(42)).toBeNull();
      expect(parse("")).toBeNull();
      expect(parse("_missing-prefix-character")).toBeNull();
      expect(parse("room/with-a-slash")).toBeNull();
      expect(parse(`room_${"a".repeat(128)}`)).toBeNull();
    },
  );

  it("exposes branded route ID parameters on the server client", () => {
    expectTypeOf<
      Parameters<SharedNetServerClient["claimPairing"]>[1]
    >().toEqualTypeOf<PairingId>();
    expectTypeOf<
      Parameters<SharedNetServerClient["getRoom"]>[1]
    >().toEqualTypeOf<RoomId>();
    expectTypeOf<
      Parameters<SharedNetServerClient["resolveDecision"]>[1]
    >().toEqualTypeOf<DecisionId>();
  });
});

describe("coordination-tag response validation", () => {
  it("accepts the existing Room API coordination-tag wire format", () => {
    expect(
      isRoomMessage({
        ...roomDetail.messages[0],
        tags: [
          {
            kind: "human_review",
            raw: "human-review-required",
            target_id: null,
          },
          {
            kind: "verification",
            raw: "verification-required",
            target_id: null,
          },
          {
            kind: "delegation",
            raw: "delegate-to:agent_target",
            target_id: "agent_target",
          },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    { kind: "human_review", raw: "@human-review", target_id: null },
    { kind: "human_review", raw: "verification-required", target_id: null },
    { kind: "verification", raw: "@verification", target_id: null },
    { kind: "verification", raw: "human-review-required", target_id: null },
    {
      kind: "delegation",
      raw: "@delegate:agent_target",
      target_id: "agent_target",
    },
    {
      kind: "delegation",
      raw: "delegate-to:agent_other",
      target_id: "agent_target",
    },
  ])("rejects a non-canonical coordination tag %#", (tag) => {
    expect(
      isRoomMessage({
        ...roomDetail.messages[0],
        tags: [tag],
      }),
    ).toBe(false);
  });
});
