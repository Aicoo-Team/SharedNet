// @vitest-environment node

import { describe, expect, it } from "vitest";

import { DISCOVERY_DOCUMENT, digestSecret } from "../../protocol/src/index";
import { handleRequest } from "./handler";
import { MemorySharedNetRepository } from "./memory-repository";

const DEV_KEY = `snk_${"a".repeat(43)}`;
const OTHER_KEY = `snk_${"b".repeat(43)}`;

function makeStore() {
  return new MemorySharedNetRepository({
    devApiKey: DEV_KEY,
    now: () => new Date("2026-09-04T10:20:30.123Z"),
  });
}

function request(
  store: MemorySharedNetRepository,
  path: string,
  init: RequestInit = {},
) {
  return handleRequest(new Request(`http://127.0.0.1:3001${path}`, init), store);
}

function apiHeaders(extra: Record<string, string> = {}, key = DEV_KEY) {
  return {
    authorization: `Bearer ${key}`,
    ...extra,
  };
}

function instanceHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

async function createAgent(store: MemorySharedNetRepository, handle: string) {
  const response = await request(store, "/api/v1/agents", {
    method: "POST",
    headers: apiHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ handle }),
  });
  expect([200, 201]).toContain(response.status);
  return { status: response.status, agent: (await json(response)).agent };
}

type StartBody = {
  runtime_kind?: string;
  cli_version?: string;
  agent_id?: string | null;
  local_instance_key?: string;
  runtime_metadata?: Record<string, string>;
  reach?: "public" | "private";
};

async function startInstance(
  store: MemorySharedNetRepository,
  body: StartBody = {},
  expectedStatus: 200 | 201 = 201,
) {
  const response = await request(store, "/api/v1/instances", {
    method: "POST",
    headers: apiHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3", ...body }),
  });
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("cache-control")).toContain("no-store");
  return json(response);
}

/** Registers an Instance under a specific key: a second Principal, with a body. */
async function startWithKey(store: MemorySharedNetRepository, key: string, body: StartBody = {}) {
  const response = await request(store, "/api/v1/instances", {
    method: "POST",
    headers: apiHeaders({ "content-type": "application/json" }, key),
    body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3", ...body }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

const SESSION_KEY = "a".repeat(64);
const OTHER_SESSION_KEY = "b".repeat(64);

describe("SharedNet V1 HTTP handler", () => {
  it("publishes the exact discovery document", async () => {
    const response = await request(makeStore(), "/api/v1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DISCOVERY_DOCUMENT);
  });

  it("registers four independent untagged Instances with nothing provisioned first", async () => {
    const store = makeStore();

    const registrations = await Promise.all(
      Array.from({ length: 4 }, () => startInstance(store)),
    );

    expect(new Set(registrations.map(({ instance }) => instance.id)).size).toBe(4);
    expect(new Set(registrations.map(({ token }) => token)).size).toBe(4);
    // A fresh Instance is untagged: there is no default Agent to be born into.
    expect(registrations.every(({ instance }) => instance.agent_id === null)).toBe(true);
    expect(
      registrations.every(({ instance }) => Object.keys(instance.runtime_metadata).length === 0),
    ).toBe(true);
    expect(registrations.every(({ token }) => /^sni_[A-Za-z0-9_-]{43}$/.test(token))).toBe(
      true,
    );

    for (const registration of registrations) {
      const current = await request(store, "/api/v1/instances/current", {
        headers: instanceHeaders(registration.token),
      });
      expect(current.status).toBe(200);
      const currentBody = await json(current);
      expect(currentBody.instance.id).toBe(registration.instance.id);
      expect(currentBody.agent).toBeNull();

      const heartbeat = await request(store, "/api/v1/instances/current/heartbeat", {
        method: "POST",
        headers: instanceHeaders(registration.token),
      });
      expect(heartbeat.status).toBe(200);
      expect((await json(heartbeat)).heartbeat_after_seconds).toBe(30);
    }

    const internals = store as any;
    const apiKeyRecord = [...internals.apiKeysByDigest.values()][0];
    expect(apiKeyRecord.digest).toBe(digestSecret(DEV_KEY));
    expect(apiKeyRecord).not.toHaveProperty("token");
    for (const record of internals.instances.values()) {
      expect(record).not.toHaveProperty("token");
      expect(record.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    const serialized = JSON.stringify([
      apiKeyRecord,
      ...internals.instances.values(),
    ]);
    expect(serialized).not.toContain(DEV_KEY);
    for (const registration of registrations) {
      expect(serialized).not.toContain(registration.token);
    }
  });

  it("returns the same Instance with a fresh token when one runtime session registers twice", async () => {
    const store = makeStore();

    const first = await startInstance(store, { local_instance_key: SESSION_KEY });
    const again = await startInstance(store, { local_instance_key: SESSION_KEY }, 200);
    const other = await startInstance(store, { local_instance_key: OTHER_SESSION_KEY });

    // One session, one live Instance — but every registration mints its own
    // token, so a recovered session never reuses a secret it may have lost.
    expect(again.instance.id).toBe(first.instance.id);
    expect(again.token).not.toBe(first.token);
    expect(other.instance.id).not.toBe(first.instance.id);

    const stale = await request(store, "/api/v1/instances/current", {
      headers: instanceHeaders(first.token),
    });
    expect(stale.status).toBe(401);
    const live = await request(store, "/api/v1/instances/current", {
      headers: instanceHeaders(again.token),
    });
    expect(live.status).toBe(200);
    expect((store as any).instances.size).toBe(2);
  });

  it("moves a re-registered Instance's tag when asked and leaves it alone otherwise", async () => {
    const store = makeStore();
    const { agent: reviewer } = await createAgent(store, "reviewer");

    const untagged = await startInstance(store, { local_instance_key: SESSION_KEY });
    expect(untagged.instance.agent_id).toBeNull();

    const tagged = await startInstance(
      store,
      {
        local_instance_key: SESSION_KEY,
        agent_id: reviewer.id,
        runtime_metadata: { hostname: "mbp" },
      },
      200,
    );
    expect(tagged.instance.id).toBe(untagged.instance.id);
    expect(tagged.instance.agent_id).toBe(reviewer.id);
    expect(tagged.instance.runtime_metadata).toEqual({ hostname: "mbp" });

    const untouched = await startInstance(store, { local_instance_key: SESSION_KEY }, 200);
    expect(untouched.instance.agent_id).toBe(reviewer.id);
    expect(untouched.instance.runtime_metadata).toEqual({ hostname: "mbp" });

    const cleared = await startInstance(
      store,
      { local_instance_key: SESSION_KEY, agent_id: null },
      200,
    );
    expect(cleared.instance.agent_id).toBeNull();

    const current = await request(store, "/api/v1/instances/current", {
      headers: instanceHeaders(cleared.token),
    });
    expect((await json(current)).agent).toBeNull();
  });

  it("refuses a tag that is not this Principal's and malformed session inputs", async () => {
    const store = makeStore();

    const foreign = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        runtime_kind: "codex",
        cli_version: "0.1.3",
        agent_id: "a_zzzzzzzzzz",
      }),
    });
    expect(foreign.status).toBe(404);
    expect((await json(foreign)).error.code).toBe("agent_not_found");

    for (const body of [
      { local_instance_key: "not-hex" },
      { local_instance_key: "a".repeat(63) },
      { agent_id: "reviewer" },
      { runtime_metadata: { "Bad Key": "x" } },
      { runtime_metadata: { hostname: 42 } },
      { runtime_metadata: { hostname: "line\nbreak" } },
      {
        runtime_metadata: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"]),
        ),
      },
    ]) {
      const response = await request(store, "/api/v1/instances", {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3", ...body }),
      });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("creates a tag once per handle and lists and fetches it", async () => {
    const store = makeStore();

    const first = await createAgent(store, "reviewer");
    const second = await createAgent(store, "Reviewer ");
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.agent.id).toBe(first.agent.id);
    expect(first.agent.handle).toBe("reviewer");
    expect(first.agent).not.toHaveProperty("is_default");

    await createAgent(store, "builder");
    const listed = await request(store, "/api/v1/agents", { headers: apiHeaders() });
    expect(listed.status).toBe(200);
    expect((await json(listed)).items.map((agent: any) => agent.handle)).toEqual([
      "builder",
      "reviewer",
    ]);

    const fetched = await request(store, `/api/v1/agents/${first.agent.id}`, {
      headers: apiHeaders(),
    });
    expect(fetched.status).toBe(200);
    expect((await json(fetched)).agent.id).toBe(first.agent.id);

    const missing = await request(store, "/api/v1/agents/a_zzzzzzzzzz", {
      headers: apiHeaders(),
    });
    expect(missing.status).toBe(404);
    const malformed = await request(store, "/api/v1/agents/not-an-id", {
      headers: apiHeaders(),
    });
    expect(malformed.status).toBe(400);
    const wrongMethod = await request(store, `/api/v1/agents/${first.agent.id}`, {
      method: "DELETE",
      headers: apiHeaders(),
    });
    expect(wrongMethod.status).toBe(405);

    for (const handle of ["", "Default!", "1abc", "a".repeat(33)]) {
      const response = await request(store, "/api/v1/agents", {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ handle }),
      });
      expect(response.status, handle).toBe(422);
    }
  });

  it("caps tags per Principal", async () => {
    const store = makeStore();
    for (let index = 0; index < 100; index += 1) {
      await createAgent(store, `tag-${index}`);
    }
    const response = await request(store, "/api/v1/agents", {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ handle: "one-too-many" }),
    });
    expect(response.status).toBe(409);
    expect((await json(response)).error.code).toBe("agent_limit_reached");
    // An existing handle is still returned, not counted against the cap.
    expect((await createAgent(store, "tag-0")).status).toBe(200);
  });

  it("lets four Instances share one chatroom with provenance that follows regrouping", async () => {
    const store = makeStore();
    const { agent } = await createAgent(store, "reviewer");
    const registrations = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        startInstance(store, {
          local_instance_key: String.fromCharCode(99 + index).repeat(64),
        }),
      ),
    );

    const createKey = crypto.randomUUID();
    const createBody = JSON.stringify({ name: "four codex room", description: "E2E" });
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(registrations[0].token, {
        "content-type": "application/json",
        "idempotency-key": createKey,
      }),
      body: createBody,
    });
    expect(created.status).toBe(201);
    const createdBody = await json(created);
    const roomId = createdBody.room.id as string;
    expect(createdBody.membership.agent_id).toBeNull();
    expect(createdBody.room.creator_instance_id).toBe(registrations[0].instance.id);
    expect(createdBody.room.creator_agent_id).toBeNull();

    const replay = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(registrations[0].token, {
        "content-type": "application/json",
        "idempotency-key": createKey,
      }),
      body: createBody,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await json(replay)).toEqual(createdBody);

    const conflict = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(registrations[0].token, {
        "content-type": "application/json",
        "idempotency-key": createKey,
      }),
      body: JSON.stringify({ name: "different room" }),
    });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe("idempotency_conflict");

    // Membership is per Instance, so a sibling Instance of the same Agent is
    // not a member until it joins for itself.
    const strangerPost = await request(store, `/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      headers: instanceHeaders(registrations[1].token, {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ content: "should not land" }),
    });
    expect(strangerPost.status).toBe(403);

    for (const registration of registrations.slice(1)) {
      const joined = await request(store, `/api/v1/rooms/${roomId}/join`, {
        method: "POST",
        headers: instanceHeaders(registration.token, {
          "idempotency-key": crypto.randomUUID(),
        }),
      });
      expect(joined.status).toBe(200);
      const membership = (await json(joined)).membership;
      expect(membership.agent_id).toBeNull();
      expect(membership.instance_id).toBe(registration.instance.id);
    }

    const posted = await Promise.all(
      registrations.map(({ token }, index) =>
        request(store, `/api/v1/rooms/${roomId}/messages`, {
          method: "POST",
          headers: instanceHeaders(token, {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          }),
          body: JSON.stringify({ content: `hello from ${index + 1}` }),
        }),
      ),
    );
    expect(posted.every((response) => response.status === 201)).toBe(true);

    const pageResponse = await request(store, `/api/v1/rooms/${roomId}/messages`, {
      headers: instanceHeaders(registrations[3].token),
    });
    expect(pageResponse.status).toBe(200);
    const page = await json(pageResponse);
    expect(page.items.map((message: any) => message.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(page.items.map((message: any) => message.sender_instance_id))).toEqual(
      new Set(registrations.map(({ instance }) => instance.id)),
    );
    expect(page.items.every((message: any) => message.sender_agent_id === null)).toBe(true);

    // Tag the first speaker after the fact. Nothing was written to the
    // messages, yet history now attributes that speaker's line to the tag,
    // because a message records who acted and derives the tag at read time.
    await startInstance(
      store,
      { local_instance_key: "c".repeat(64), agent_id: agent.id },
      200,
    );
    const regrouped = await json(
      await request(store, `/api/v1/rooms/${roomId}/messages`, {
        headers: instanceHeaders(registrations[3].token),
      }),
    );
    expect(regrouped.items.map((message: any) => message.sender_agent_id)).toEqual([
      agent.id,
      null,
      null,
      null,
    ]);
    const detail = await json(
      await request(store, `/api/v1/rooms/${roomId}`, {
        headers: instanceHeaders(registrations[3].token),
      }),
    );
    expect(detail.room.creator_agent_id).toBe(agent.id);
    expect(
      detail.memberships.find(
        (member: any) => member.instance_id === registrations[0].instance.id,
      ).agent_id,
    ).toBe(agent.id);
  });

  it("authenticates before parsing a protected request body", async () => {
    const store = makeStore();
    const response = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: {
        authorization: "Bearer definitely-not-a-token",
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: "{ broken",
    });

    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe("invalid_credentials");
  });

  it("executes concurrent replays only once", async () => {
    const store = makeStore();
    const registration = await startInstance(store);
    const key = crypto.randomUUID();
    const create = () =>
      request(store, "/api/v1/rooms", {
        method: "POST",
        headers: instanceHeaders(registration.token, {
          "content-type": "application/json",
          "idempotency-key": key,
        }),
        body: JSON.stringify({ name: "one room" }),
      });

    const responses = await Promise.all([create(), create()]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(
      responses.filter((response) => response.headers.get("idempotency-replayed") === "true"),
    ).toHaveLength(1);
    expect((store as any).rooms).toHaveLength(1);
  });

  it("rejects idempotency on raw Instance token issuance", async () => {
    const store = makeStore();
    const response = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: apiHeaders({
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3" }),
    });

    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe("idempotency_not_supported");
  });
});

describe("GET /api/v1/rooms/{room_id}", () => {
  async function seededRoom() {
    const store = makeStore();
    const { token } = await startInstance(store);
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(token, {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ name: "Detail room" }),
    });
    expect(created.status).toBe(201);
    return { store, token, roomId: (await json(created)).room.id as string };
  }

  it("returns the Room and its memberships for a member Instance", async () => {
    const { store, token, roomId } = await seededRoom();

    const response = await request(store, `/api/v1/rooms/${roomId}`, {
      headers: instanceHeaders(token),
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.room.id).toBe(roomId);
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].state).toBe("active");
  });

  it("rejects an account API key, which is the wrong credential class", async () => {
    const { store, roomId } = await seededRoom();

    const response = await request(store, `/api/v1/rooms/${roomId}`, {
      headers: apiHeaders(),
    });

    expect(response.status).toBe(401);
  });

  it("answers 404 for a Room id that does not exist", async () => {
    const { store, token } = await seededRoom();

    const response = await request(
      store,
      "/api/v1/rooms/rom_lxw0rfaLIb",
      { headers: instanceHeaders(token) },
    );

    expect(response.status).toBe(404);
  });

  it("rejects a malformed Room id before any lookup", async () => {
    const { store, token } = await seededRoom();

    const response = await request(store, "/api/v1/rooms/not-a-room-id", {
      headers: instanceHeaders(token),
    });

    expect(response.status).toBe(400);
  });

  it("allows only GET", async () => {
    const { store, token, roomId } = await seededRoom();

    const response = await request(store, `/api/v1/rooms/${roomId}`, {
      method: "DELETE",
      headers: instanceHeaders(token),
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

describe("Rooms across Principals", () => {
  const now = () => new Date("2026-09-04T10:20:30.123Z");

  async function startAs(store: MemorySharedNetRepository, key: string, body: StartBody = {}) {
    const response = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }, key),
      body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3", ...body }),
    });
    expect(response.status).toBe(201);
    return json(response);
  }

  it("lets an Instance of another Principal join by Room id, and read only once it has", async () => {
    const store = new MemorySharedNetRepository({ devApiKeys: [DEV_KEY, OTHER_KEY], now });
    const owner = await startAs(store, DEV_KEY);
    const guest = await startAs(store, OTHER_KEY);
    expect(guest.instance.principal_id).not.toBe(owner.instance.principal_id);

    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(owner.token, {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ name: "Shared by id" }),
    });
    expect(created.status).toBe(201);
    const roomId = (await json(created)).room.id as string;

    // Knowing the id is not yet membership: reading is refused until joined.
    const peek = await request(store, `/api/v1/rooms/${roomId}`, {
      headers: instanceHeaders(guest.token),
    });
    expect(peek.status).toBe(403);
    expect((await json(peek)).error.code).toBe("room_membership_required");

    const joined = await request(store, `/api/v1/rooms/${roomId}/join`, {
      method: "POST",
      headers: instanceHeaders(guest.token, { "idempotency-key": crypto.randomUUID() }),
    });
    expect(joined.status).toBe(200);
    const membership = (await json(joined)).membership;
    expect(membership.instance_id).toBe(guest.instance.id);

    const posted = await request(store, `/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      headers: instanceHeaders(guest.token, {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ content: "hello from another Principal" }),
    });
    expect(posted.status).toBe(201);
    expect((await json(posted)).message.sender_principal_id).toBe(guest.instance.principal_id);

    // The owner sees the guest as a member with the guest's own Principal,
    // and reads the guest's message with truthful provenance.
    const detail = await json(
      await request(store, `/api/v1/rooms/${roomId}`, { headers: instanceHeaders(owner.token) }),
    );
    expect(detail.room.principal_id).toBe(owner.instance.principal_id);
    expect(detail.memberships.map((member: any) => member.instance_id).sort()).toEqual(
      [owner.instance.id, guest.instance.id].sort(),
    );
    const page = await json(
      await request(store, `/api/v1/rooms/${roomId}/messages`, {
        headers: instanceHeaders(owner.token),
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].sender_principal_id).toBe(guest.instance.principal_id);
    expect(page.items[0].sender_instance_id).toBe(guest.instance.id);
  });
});

});

describe("Room invites, guests, and wait", () => {
  const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  async function openRoom(store: MemorySharedNetRepository) {
    const host = await startInstance(store);
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(host.token, {
        "content-type": "application/json",
        "idempotency-key": UUID,
      }),
      body: JSON.stringify({ name: "Launch review" }),
    });
    expect(created.status).toBe(201);
    const { room } = await json(created);
    const principalId = host.instance.principal_id;
    return { host, room, principalId };
  }

  async function say(
    store: MemorySharedNetRepository,
    roomId: string,
    token: string,
    content: string,
    key?: string,
  ) {
    return request(store, `/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      headers: instanceHeaders(token, {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      }),
      body: JSON.stringify({ content }),
    });
  }

  it("admits a guest by invite token, hands back a member token and the history, and lets it speak", async () => {
    const store = makeStore();
    const { host, room, principalId } = await openRoom(store);
    expect((await say(store, room.id, host.token, "Welcome", UUID)).status).toBe(201);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    expect(invite).toMatch(/^rit_[A-Za-z0-9_-]{43}$/);

    const joined = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "claude-code" }),
    });
    expect(joined.status).toBe(200);
    expect(joined.headers.get("cache-control")).toContain("no-store");
    const body = await json(joined);
    // Every member is an Instance of a Principal: the Agent that arrived with
    // only an invite gets an anonymous Principal of its own and an Instance token.
    expect(body.member_token).toMatch(/^sni_[A-Za-z0-9_-]{43}$/);
    expect(body.membership).toMatchObject({
      kind: "guest",
      name: "claude-code",
      invited_by_principal_id: principalId,
      admitted_by: "invite",
      presence: "online",
      state: "active",
    });
    expect(body.membership.member_id).toMatch(/^i_[A-Za-z0-9]{10}$/);
    expect(body.membership.instance_id).toBe(body.membership.member_id);
    expect(body.membership.principal_id).toMatch(/^p_[A-Za-z0-9]{10}$/);
    expect(body.membership.principal_id).not.toBe(principalId);
    expect(body.history.items.map((m: any) => m.content)).toEqual(["Welcome"]);
    expect(body.history.items[0].sender).toEqual({
      member_id: host.instance.id,
      kind: "instance",
      name: null,
    });

    // The guest speaks with plain curl: no Idempotency-Key required.
    const spoke = await say(store, room.id, body.member_token, "Hello from a guest");
    expect(spoke.status).toBe(201);
    const message = (await json(spoke)).message;
    expect(message).toMatchObject({
      sequence: 2,
      type: "message",
      sender_instance_id: body.membership.member_id,
      sender_principal_id: body.membership.principal_id,
      sender: { member_id: body.membership.member_id, kind: "guest", name: "claude-code" },
    });

    // The host reads it with the sender attributed to the guest by name.
    const page = await request(store, `/api/v1/rooms/${room.id}/messages?after=1`, {
      headers: instanceHeaders(host.token),
    });
    expect((await json(page)).items[0].sender.name).toBe("claude-code");

    // Both kinds of member appear in the Room, each with presence.
    const detail = await request(store, `/api/v1/rooms/${room.id}`, {
      headers: { authorization: `Bearer ${body.member_token}` },
    });
    expect(detail.status).toBe(200);
    const members = (await json(detail)).memberships;
    expect(members.map((m: any) => m.kind).sort()).toEqual(["guest", "instance"]);
    expect(members.every((m: any) => m.presence === "online")).toBe(true);

    // Nothing secret is stored raw.
    const serialized = JSON.stringify([...(store as any).instances.values(), ...(store as any).invites.values()]);
    expect(serialized).not.toContain(invite);
    expect(serialized).not.toContain(body.member_token);
  });

  it("honours an Idempotency-Key from a guest when one is sent", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "codex" });

    const first = await say(store, room.id, memberToken, "once", UUID);
    const again = await say(store, room.id, memberToken, "once", UUID);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect((await json(again)).message.id).toBe((await json(first)).message.id);
  });

  it("gives every join its own member: a name never recovers someone else's identity", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const one = await store.joinRoomWithInvite(invite, room.id, { name: "claude-code" });
    const two = await store.joinRoomWithInvite(invite, room.id, { name: "claude-code" });
    expect(two.membership.member_id).not.toBe(one.membership.member_id);
    expect(two.member_token).not.toBe(one.member_token);
  });

  it("rejects an invite that is unknown, for another Room, revoked, or expired", async () => {
    let clock = new Date("2026-09-05T12:00:00Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => clock });
    const { room, principalId } = await openRoom(store);
    const other = await openRoom(store);
    const join = (token: string, roomId = room.id) =>
      request(store, `/api/v1/rooms/${roomId}/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "guest" }),
      });

    expect((await join(`rit_${"z".repeat(43)}`)).status).toBe(401);

    const { token: forOther } = await store.createRoomInvite({ roomId: other.room.id, principalId });
    expect((await join(forOther)).status).toBe(401);

    const { invite, token } = await store.createRoomInvite({ roomId: room.id, principalId });
    await store.revokeRoomInvite({ inviteId: invite.id, principalId });
    const revoked = await join(token);
    expect(revoked.status).toBe(410);
    expect((await json(revoked)).error.code).toBe("invite_revoked");

    const { token: shortLived, invite: timed } = await store.createRoomInvite({
      roomId: room.id,
      principalId,
      expiresInSeconds: 60,
    });
    expect(timed.expires_at).toBe("2026-09-05T12:01:00.000Z");
    clock = new Date("2026-09-05T12:02:00Z");
    const expired = await join(shortLived);
    expect(expired.status).toBe(410);
    expect((await json(expired)).error.code).toBe("invite_expired");

    // A forever invite (the default) is unaffected by the clock.
    const { token: forever, invite: standing } = await store.createRoomInvite({ roomId: room.id, principalId });
    expect(standing.expires_at).toBeNull();
    clock = new Date("2027-09-05T12:00:00Z");
    expect((await join(forever)).status).toBe(200);
  });

  it("redeems a claim the signed-in Web minted: the key once, then the code is spent", async () => {
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const { principalId } = await openRoom(store);
    const { claim } = await store.createCliClaim({ principalId, label: "join Hackathon" });
    const redeem = (bearer: string) =>
      request(store, "/api/v1/cli/claims/redeem", { method: "POST", headers: { authorization: `Bearer ${bearer}` } });

    const redeemed = await redeem(claim);
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get("cache-control")).toContain("no-store");
    const body = await json(redeemed);
    expect(body.state).toBe("approved");
    expect(body.principal.id).toBe(principalId);
    expect(body.api_key).toMatch(/^snk_/);

    // The key is the account's: it registers Instances of that Principal.
    const started = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: { authorization: `Bearer ${body.api_key}`, "content-type": "application/json" },
      body: JSON.stringify({ runtime_kind: "claude-code", cli_version: "0.1.3" }),
    });
    expect(started.status).toBe(201);
    expect((await json(started)).instance.principal_id).toBe(principalId);

    // Spent: a second redemption, an unknown code, and a token of another kind all fail.
    const again = await redeem(claim);
    expect(again.status).toBe(410);
    expect((await json(again)).error.code).toBe("login_consumed");
    expect((await redeem(`clp_${"n".repeat(43)}`)).status).toBe(404);
    expect((await redeem(`sni_${"x".repeat(43)}`)).status).toBe(401);
    expect((await request(store, "/api/v1/cli/claims/redeem", { method: "POST" })).status).toBe(401);
  });

  it("mints an invite for the Room's owner through the API, with the link for people, and for nobody else", async () => {
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const { host, room } = await openRoom(store);
    const mint = (token: string) =>
      request(store, `/api/v1/rooms/${room.id}/invites`, { method: "POST", headers: instanceHeaders(token) });

    const minted = await mint(host.token);
    expect(minted.status).toBe(201);
    const body = await json(minted);
    expect(body.token).toMatch(/^rit_[A-Za-z0-9_-]{43}$/);
    expect(body.link).toBe(`http://127.0.0.1:3001/join/${body.token}`);
    expect(body.invite).toMatchObject({ room_id: room.id, expires_at: null, revoked_at: null, uses: 0 });
    // The token opens that Room, and only that Room.
    const described = await request(store, "/api/v1/invites/current", { headers: { authorization: `Bearer ${body.token}` } });
    expect((await json(described)).room.id).toBe(room.id);

    // A guest seated by that very invite owns nothing: the Room reads as absent to it.
    const guest = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "claude-code" }),
    });
    expect(guest.status).toBe(200);
    const refused = await mint((await json(guest)).member_token);
    expect(refused.status).toBe(404);
    expect((await json(refused)).error.code).toBe("room_not_found");
    expect((await request(store, `/api/v1/rooms/${room.id}/invites`, { method: "POST" })).status).toBe(401);
    expect((await request(store, `/api/v1/rooms/${room.id}/invites`, { headers: instanceHeaders(host.token) })).status).toBe(405);
  });

  it("names the oldest CLI it registers, and refuses an older one with the command to run", async () => {
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const index = await json(await request(store, "/api/v1"));
    expect(index.min_cli_version).toBe("0.1.3");
    const register = (cli_version: string) =>
      request(store, "/api/v1/instances", {
        method: "POST",
        headers: { authorization: `Bearer ${DEV_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ runtime_kind: "claude-code", cli_version }),
      });
    const old = await register("0.1.2");
    expect(old.status).toBe(426);
    const body = await json(old);
    expect(body.error.code).toBe("cli_upgrade_required");
    expect(body.error.message).toContain("npx -y sharednet@latest");
    expect((await register("0.1.3")).status).toBe(201);
    expect((await register("0.2.0")).status).toBe(201);
    // A version that is not a version (a script, an invite seat) is not judged.
    expect((await register("scenario")).status).toBe(201);
  });

  it("reads a Room's log as filter, order, window: grep, by sender, by tag, newest first, paged backward", async () => {
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const { host, room } = await openRoom(store);
    const other = await startInstance(store);
    await request(store, `/api/v1/rooms/${room.id}/join`, { method: "POST", headers: instanceHeaders(other.token, { "idempotency-key": "1f7f2c1e-4d6b-4b6e-8f1a-2b3c4d5e6f71" }) });
    const lines = ["deploy window opens at 14:00", "rollback takes 10 minutes", "Deploy moved to 13:55", "lunch?", "deploy is go"];
    for (const [i, line] of lines.entries()) {
      const author = i % 2 === 0 ? host.token : other.token;
      const posted = await say(store, room.id, author, line, `0f7f2c1e-4d6b-4b6e-8f1a-2b3c4d5e6f${String(80 + i)}`);
      expect(posted.status).toBe(201);
    }
    const read = async (query: string) => {
      const response = await request(store, `/api/v1/rooms/${room.id}/messages${query}`, { headers: instanceHeaders(host.token) });
      return { status: response.status, body: await json(response) };
    };
    // grep: case-insensitive substring, log order.
    const grep = await read("?q=deploy");
    expect(grep.body.items.map((m: any) => m.sequence)).toEqual([1, 3, 5]);
    // newest first, top k: [-2:].
    const last = await read("?order=desc&limit=2");
    expect(last.body.items.map((m: any) => m.sequence)).toEqual([5, 4]);
    expect(last.body.next_cursor).toBe("4");
    // and the page before it, continuing backward.
    const earlier = await read("?before=4&limit=2");
    expect(earlier.body.items.map((m: any) => m.sequence)).toEqual([3, 2]);
    expect(earlier.body.has_more).toBe(true);
    // by sender, and by tag (both untagged here).
    const byOther = await read(`?sender_instance_id=${other.instance.id}`);
    expect(byOther.body.items.map((m: any) => m.sequence)).toEqual([2, 4]);
    const untagged = await read("?sender_agent_id=default&q=deploy");
    expect(untagged.body.items.map((m: any) => m.sequence)).toEqual([1, 3, 5]);
    const tagged = await read("?sender_agent_id=a_AbCdEfGhIj");
    expect(tagged.body.items).toEqual([]);
    // The default read is unchanged: everything, oldest first, fifty at a time.
    const plain = await read("");
    expect(plain.body.items.map((m: any) => m.sequence)).toEqual([1, 2, 3, 4, 5]);
    // Contradictions and junk are refused, not guessed.
    expect((await read("?after=1&before=3")).status).toBe(400);
    expect((await read("?after=1&order=desc")).status).toBe(400);
    expect((await read("?order=sideways")).status).toBe(400);
    expect((await read("?q=")).status).toBe(400);
    expect((await read("?sender_instance_id=nope")).status).toBe(400);
    expect((await read("?rank=bm25")).status).toBe(400);
  });

  it("tells the join page what an invite opens, and only that", async () => {
    let clock = new Date("2026-09-07T12:00:00Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => clock });
    const { room, principalId } = await openRoom(store);
    const { token, invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const describe = (bearer: string) => request(store, "/api/v1/invites/current", { headers: { authorization: `Bearer ${bearer}` } });

    const described = await describe(token);
    expect(described.status).toBe(200);
    expect(await json(described)).toEqual({
      room: { id: room.id, name: room.name, state: "open" },
      invite: { id: invite.id, expires_at: null, uses: 0 },
    });
    // No token, or a token of another kind, opens nothing.
    expect((await request(store, "/api/v1/invites/current")).status).toBe(401);
    expect((await describe(`sni_${"x".repeat(43)}`)).status).toBe(401);
    expect((await describe(`rit_${"z".repeat(43)}`)).status).toBe(401);
    await store.revokeRoomInvite({ inviteId: invite.id, principalId });
    const revoked = await describe(token);
    expect(revoked.status).toBe(410);
    expect((await json(revoked)).error.code).toBe("invite_revoked");
    const { token: brief } = await store.createRoomInvite({ roomId: room.id, principalId, expiresInSeconds: 60 });
    clock = new Date("2026-09-07T12:05:00Z");
    expect((await json(await describe(brief))).error.code).toBe("invite_expired");
  });

  it("keeps a guest inside its own Room only", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const other = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });

    const foreign = await request(store, `/api/v1/rooms/${other.room.id}/messages`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(foreign.status).toBe(403);
    expect((await json(foreign)).error.code).toBe("room_membership_required");

    // It is an Instance, of an anonymous Principal that records who invited it.
    const self = await request(store, "/api/v1/instances/current", {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(self.status).toBe(200);
    const current = await json(self);
    expect(current.principal.invited_by_principal_id).toBe(principalId);
    expect(current.instance.display_name).toBe("guest");
    expect(current.instance.token_expires_at).toBeNull();
    expect(current.agent).toBeNull();
  });

  it("keeps an Instance registered with a key usable years later: Instances are permanent", async () => {
    let clock = new Date("2026-09-06T12:00:00Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => clock });
    const started = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: { authorization: `Bearer ${DEV_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ runtime_kind: "claude-code", cli_version: "0.1.3" }),
    });
    expect(started.status).toBe(201);
    const { instance, token } = await json(started);
    expect(instance.token_expires_at).toBeNull();

    clock = new Date("2028-09-06T12:00:00Z");
    const beat = await request(store, "/api/v1/instances/current/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(beat.status).toBe(200);
    const current = await request(store, "/api/v1/instances/current", { headers: { authorization: `Bearer ${token}` } });
    expect(current.status).toBe(200);
    expect((await json(current)).instance.id).toBe(instance.id);
  });

  it("keeps an account seat online while it only reads: any authenticated request renews the lease", async () => {
    let clock = new Date("2026-09-06T12:00:00Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => clock });
    const { token, instance } = await startInstance(store);
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(token, { "content-type": "application/json", "idempotency-key": UUID }),
      body: JSON.stringify({ name: "Quiet" }),
    });
    const { room } = await json(created);

    // An hour of nothing but polling the Room, no heartbeat from the CLI.
    clock = new Date("2026-09-06T13:00:00Z");
    const polled = await request(store, `/api/v1/rooms/${room.id}/wait?after=0&timeout=0`, { headers: instanceHeaders(token) });
    expect(polled.status).toBe(200);
    const seen = await json(await request(store, "/api/v1/instances/current", { headers: instanceHeaders(token) }));
    expect(seen.instance.id).toBe(instance.id);
    expect(seen.instance.status).toBe("online");
    // And it can still speak: posting requires an online Instance.
    const said = await request(store, `/api/v1/rooms/${room.id}/messages`, {
      method: "POST",
      headers: instanceHeaders(token, { "content-type": "application/json", "idempotency-key": "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b" }),
      body: JSON.stringify({ content: "still here" }),
    });
    expect(said.status).toBe(201);
  });

  it("forms a group: a public Instance is seated at once and finds the Room in its list", async () => {
    const store = new MemorySharedNetRepository({ devApiKeys: [DEV_KEY, OTHER_KEY], now: () => new Date("2026-09-06T12:00:00Z") });
    const host = await startInstance(store);
    const guest = await startWithKey(store, OTHER_KEY);
    expect(guest.instance.reach).toBe("public");

    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": UUID }),
      body: JSON.stringify({ name: "Formed", with: [guest.instance.id, "i_NoSuchInst"] }),
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    // Refused says nothing about why: an unknown id reads like a private no.
    expect(body.admissions).toEqual([
      { instance_id: guest.instance.id, status: "member", decision_id: null },
      { instance_id: "i_NoSuchInst", status: "refused", decision_id: null },
    ]);

    // The guest is a member: the Room is in its list, it can read, and the seat says who added it.
    const list = await request(store, "/api/v1/rooms", { headers: instanceHeaders(guest.token) });
    expect(list.status).toBe(200);
    expect((await json(list)).items.map((room: any) => room.id)).toEqual([body.room.id]);
    const detail = await request(store, `/api/v1/rooms/${body.room.id}`, { headers: instanceHeaders(guest.token) });
    expect(detail.status).toBe(200);
    const seat = (await json(detail)).memberships.find((m: any) => m.member_id === guest.instance.id);
    expect(seat).toMatchObject({ admitted_by: "added", added_by_instance_id: host.instance.id, state: "active" });

    // Adding again is a no-op, and only an active member may add.
    const again = await request(store, `/api/v1/rooms/${body.room.id}/members`, {
      method: "POST",
      headers: instanceHeaders(guest.token, { "content-type": "application/json" }),
      body: JSON.stringify({ with: [host.instance.id] }),
    });
    expect((await json(again)).admissions).toEqual([{ instance_id: host.instance.id, status: "member", decision_id: null }]);
    const outsider = await startWithKey(store, OTHER_KEY, { local_instance_key: OTHER_SESSION_KEY });
    const denied = await request(store, `/api/v1/rooms/${body.room.id}/members`, {
      method: "POST",
      headers: instanceHeaders(outsider.token, { "content-type": "application/json" }),
      body: JSON.stringify({ with: [outsider.instance.id] }),
    });
    expect(denied.status).toBe(403);
  });

  it("asks a private Instance first, and the Instance answers for itself through the API", async () => {
    const store = new MemorySharedNetRepository({ devApiKeys: [DEV_KEY, OTHER_KEY], now: () => new Date("2026-09-06T12:00:00Z") });
    const host = await startInstance(store);
    const guest = await startWithKey(store, OTHER_KEY);
    const patched = await request(store, "/api/v1/instances/current", {
      method: "PATCH",
      headers: instanceHeaders(guest.token, { "content-type": "application/json" }),
      body: JSON.stringify({ reach: "private" }),
    });
    expect(patched.status).toBe(200);
    expect((await json(patched)).instance.reach).toBe("private");

    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": UUID }),
      body: JSON.stringify({ name: "Asked", with: [guest.instance.id] }),
    });
    const { room, admissions } = await json(created);
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({ instance_id: guest.instance.id, status: "pending" });
    const decisionId = admissions[0].decision_id as string;
    expect(decisionId).toMatch(/^dec_/);

    // Not a member yet: no Room in the list, no reading.
    expect((await json(await request(store, "/api/v1/rooms", { headers: instanceHeaders(guest.token) }))).items).toEqual([]);
    expect((await request(store, `/api/v1/rooms/${room.id}`, { headers: instanceHeaders(guest.token) })).status).toBe(403);

    // The request is a Decision addressed to the guest, and only the guest sees it.
    const mine = await json(await request(store, "/api/v1/decisions?status=pending", { headers: instanceHeaders(guest.token) }));
    expect(mine.decisions).toHaveLength(1);
    expect(mine.decisions[0]).toMatchObject({
      id: decisionId,
      mode: "approval",
      status: "pending",
      room_id: room.id,
      requested_by_instance_id: host.instance.id,
      requested_for_instance_id: guest.instance.id,
      principal_id: guest.instance.principal_id,
    });
    expect((await json(await request(store, "/api/v1/decisions", { headers: instanceHeaders(host.token) }))).decisions).toEqual([]);
    const notYours = await request(store, `/api/v1/decisions/${decisionId}/resolve`, {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json" }),
      body: JSON.stringify({ resolution: "approved" }),
    });
    expect(notYours.status).toBe(404);

    // Asking again while it is pending returns the same Decision.
    const askedAgain = await request(store, `/api/v1/rooms/${room.id}/members`, {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json" }),
      body: JSON.stringify({ with: [guest.instance.id] }),
    });
    expect((await json(askedAgain)).admissions[0]).toEqual({ instance_id: guest.instance.id, status: "pending", decision_id: decisionId });

    // The guest approves with its own token: seated, and the Room appears.
    const approved = await request(store, `/api/v1/decisions/${decisionId}/resolve`, {
      method: "POST",
      headers: instanceHeaders(guest.token, { "content-type": "application/json" }),
      body: JSON.stringify({ resolution: "approved" }),
    });
    expect(approved.status).toBe(200);
    const outcome = await json(approved);
    expect(outcome.decision.status).toBe("approved");
    expect(outcome.membership).toMatchObject({ room_id: room.id, admitted_by: "accepted", added_by_instance_id: host.instance.id });
    expect((await json(await request(store, "/api/v1/rooms", { headers: instanceHeaders(guest.token) }))).items.map((r: any) => r.id)).toEqual([room.id]);
    const twice = await request(store, `/api/v1/decisions/${decisionId}/resolve`, {
      method: "POST",
      headers: instanceHeaders(guest.token, { "content-type": "application/json" }),
      body: JSON.stringify({ resolution: "approved" }),
    });
    expect(twice.status).toBe(409);

    // A denial seats nobody and looks, to the asker, like any other refusal later on.
    const second = await startWithKey(store, OTHER_KEY, { local_instance_key: OTHER_SESSION_KEY, reach: "private" });
    const asked = await json(await request(store, `/api/v1/rooms/${room.id}/members`, {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json" }),
      body: JSON.stringify({ with: [second.instance.id] }),
    }));
    const deniedOutcome = await json(await request(store, `/api/v1/decisions/${asked.admissions[0].decision_id}/resolve`, {
      method: "POST",
      headers: instanceHeaders(second.token, { "content-type": "application/json" }),
      body: JSON.stringify({ resolution: "denied" }),
    }));
    expect(deniedOutcome.decision.status).toBe("denied");
    expect(deniedOutcome.membership).toBeNull();
    expect((await request(store, `/api/v1/rooms/${room.id}`, { headers: instanceHeaders(second.token) })).status).toBe(403);
  });

  it("records the driver an invite join declares, and refuses a malformed one", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });

    const declared = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "codex",
        runtime: { kind: "codex", version: "0.153.0", entrypoint: "exec", source: "detected" },
      }),
    });
    expect(declared.status).toBe(200);
    const seat = (await json(declared)).membership;
    expect(seat).toMatchObject({
      runtime_kind: "codex",
      runtime_version: "0.153.0",
      runtime_metadata: { runtime_source: "detected", driver_version: "0.153.0", entrypoint: "exec" },
    });

    const bare = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "curl" }),
    });
    expect((await json(bare)).membership).toMatchObject({
      runtime_kind: "custom",
      runtime_version: "invite",
      runtime_metadata: {},
    });

    const malformed = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", runtime: { kind: "Not A Handle" } }),
    });
    expect(malformed.status).toBe(422);
  });

  it("lets an Instance join with an invite as its own Principal, and refuses an invite for another Room", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const other = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const joiner = await startInstance(store, { local_instance_key: OTHER_SESSION_KEY });

    const wrongRoom = await request(store, `/api/v1/rooms/${other.room.id}/join`, {
      method: "POST",
      headers: instanceHeaders(joiner.token, { "content-type": "application/json", "idempotency-key": UUID }),
      body: JSON.stringify({ invite }),
    });
    expect(wrongRoom.status).toBe(401);

    const joined = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: instanceHeaders(joiner.token, {
        "content-type": "application/json",
        "idempotency-key": "3f2504e0-4f89-41d3-9a0c-0305e82c3399",
      }),
      body: JSON.stringify({ invite }),
    });
    expect(joined.status).toBe(200);
    const body = await json(joined);
    expect(body.membership).toMatchObject({
      kind: "instance",
      member_id: joiner.instance.id,
      instance_id: joiner.instance.id,
      principal_id: joiner.instance.principal_id,
      admitted_by: "invite",
      name: null,
    });
    expect(body.membership.invite_id).toMatch(/^inv_[A-Za-z0-9]{10}$/);

    const bareBody = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: instanceHeaders(joiner.token, {
        "content-type": "application/json",
        "idempotency-key": "3f2504e0-4f89-41d3-9a0c-0305e82c3398",
      }),
      body: JSON.stringify({ invite: "not-an-invite" }),
    });
    expect(bareBody.status).toBe(422);
  });

  it("returns at once from wait when something was said after the cursor", async () => {
    const store = makeStore();
    const { host, room, principalId } = await openRoom(store);
    await say(store, room.id, host.token, "first", UUID);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });

    const response = await request(store, `/api/v1/rooms/${room.id}/wait?after=0&timeout=25`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const page = await json(response);
    expect(page.items.map((m: any) => m.content)).toEqual(["first"]);
    expect(page.next_cursor).toBe("1");
  });

  it("blocks in wait until a message arrives, then answers with it", async () => {
    const store = makeStore();
    const { host, room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });

    const waiting = handleRequest(
      new Request(`http://127.0.0.1:3001/api/v1/rooms/${room.id}/wait?after=0&timeout=5`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
      store,
      { waitPollMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await say(store, room.id, host.token, "you there?", UUID);

    const page = await json(await waiting);
    expect(page.items.map((m: any) => m.content)).toEqual(["you there?"]);
  });

  it("answers wait with an empty page at the timeout and refuses a timeout past the cap", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });

    const empty = await handleRequest(
      new Request(`http://127.0.0.1:3001/api/v1/rooms/${room.id}/wait?after=0&timeout=0`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
      store,
      { waitPollMs: 5 },
    );
    expect(empty.status).toBe(200);
    expect(await json(empty)).toEqual({ items: [], next_cursor: null, has_more: false });

    const tooLong = await request(store, `/api/v1/rooms/${room.id}/wait?timeout=26`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(tooLong.status).toBe(400);
  });

  describe("GET /api/v1/inbox", () => {
    const uuid = (n: number) => `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(n).padStart(2, "0")}`;

    /** A clock that moves, so the inbox order is time first and not just Room id. */
    function tickingStore() {
      let tick = Date.parse("2026-09-05T12:00:00.000Z");
      return new MemorySharedNetRepository({
        devApiKey: DEV_KEY,
        now: () => new Date((tick += 1000)),
      });
    }

    async function openRoomAs(store: MemorySharedNetRepository, token: string, name: string, key: string) {
      const created = await request(store, "/api/v1/rooms", {
        method: "POST",
        headers: instanceHeaders(token, { "content-type": "application/json", "idempotency-key": key }),
        body: JSON.stringify({ name }),
      });
      expect(created.status).toBe(201);
      return (await json(created)).room;
    }

    async function inbox(store: MemorySharedNetRepository, token: string, query = "") {
      const response = await request(store, `/api/v1/inbox${query}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await json(response), headers: response.headers };
    }

    it("gathers an Instance's Rooms in the order things were said, and resumes from an opaque cursor", async () => {
      const store = tickingStore();
      const host = await startInstance(store);
      const alpha = await openRoomAs(store, host.token, "Alpha", uuid(1));
      const beta = await openRoomAs(store, host.token, "Beta", uuid(2));
      await say(store, alpha.id, host.token, "alpha one", uuid(3));
      await say(store, beta.id, host.token, "beta one", uuid(4));
      await say(store, alpha.id, host.token, "alpha two", uuid(5));

      const all = await inbox(store, host.token);
      expect(all.status).toBe(200);
      expect(all.headers.get("cache-control")).toContain("no-store");
      expect(all.body.items.map((m: any) => [m.room_id, m.sequence, m.content])).toEqual([
        [alpha.id, 1, "alpha one"],
        [beta.id, 1, "beta one"],
        [alpha.id, 2, "alpha two"],
      ]);
      expect(all.body.has_more).toBe(false);
      expect(all.body.next_cursor).toMatch(/^ibx_[A-Za-z0-9_-]+$/);

      // Nothing new after the last cursor: an empty page that keeps the cursor.
      const caughtUp = await inbox(store, host.token, `?after=${encodeURIComponent(all.body.next_cursor)}`);
      expect(caughtUp.body).toEqual({ items: [], next_cursor: all.body.next_cursor, has_more: false });

      // Paging: one at a time, each page resuming exactly where the last stopped.
      const first = await inbox(store, host.token, "?limit=1");
      expect(first.body.items.map((m: any) => m.content)).toEqual(["alpha one"]);
      expect(first.body.has_more).toBe(true);
      const second = await inbox(store, host.token, `?limit=1&after=${encodeURIComponent(first.body.next_cursor)}`);
      expect(second.body.items.map((m: any) => m.content)).toEqual(["beta one"]);
      const third = await inbox(store, host.token, `?limit=1&after=${encodeURIComponent(second.body.next_cursor)}`);
      expect(third.body.items.map((m: any) => m.content)).toEqual(["alpha two"]);
      expect(third.body.has_more).toBe(false);
    });

    it("shows a member only the Rooms it is in: a second Instance in one Room, a guest in its one Room", async () => {
      const store = tickingStore();
      const host = await startInstance(store);
      const alpha = await openRoomAs(store, host.token, "Alpha", uuid(1));
      const beta = await openRoomAs(store, host.token, "Beta", uuid(2));
      await say(store, alpha.id, host.token, "alpha one", uuid(3));
      await say(store, beta.id, host.token, "beta one", uuid(4));

      const other = await startInstance(store, { local_instance_key: OTHER_SESSION_KEY });
      const joined = await request(store, `/api/v1/rooms/${beta.id}/join`, {
        method: "POST",
        headers: instanceHeaders(other.token, { "idempotency-key": uuid(6) }),
      });
      expect(joined.status).toBe(200);
      const otherInbox = await inbox(store, other.token);
      expect(otherInbox.body.items.map((m: any) => [m.room_id, m.content])).toEqual([[beta.id, "beta one"]]);

      const { token: invite } = await store.createRoomInvite({
        roomId: alpha.id,
        principalId: host.instance.principal_id,
      });
      const { member_token: guestToken } = await store.joinRoomWithInvite(invite, alpha.id, { name: "guest" });
      const guestInbox = await inbox(store, guestToken);
      expect(guestInbox.body.items.map((m: any) => [m.room_id, m.content])).toEqual([[alpha.id, "alpha one"]]);

      const nobody = await startInstance(store, { local_instance_key: "c".repeat(64) });
      const empty = await inbox(store, nobody.token);
      expect(empty.body).toEqual({ items: [], next_cursor: null, has_more: false });
    });

    it("refuses a cursor that is not an inbox cursor, an unknown parameter, a bad limit, and the wrong method", async () => {
      const store = tickingStore();
      const host = await startInstance(store);

      const numeric = await inbox(store, host.token, "?after=5");
      expect(numeric.status).toBe(400);
      expect(numeric.body.error.code).toBe("invalid_cursor");
      const unknown = await inbox(store, host.token, "?since=1");
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.code).toBe("invalid_request");
      const limit = await inbox(store, host.token, "?limit=0");
      expect(limit.status).toBe(400);
      const posted = await request(store, "/api/v1/inbox", {
        method: "POST",
        headers: instanceHeaders(host.token),
      });
      expect(posted.status).toBe(405);
      const anonymous = await request(store, "/api/v1/inbox");
      expect(anonymous.status).toBe(401);
      const apiKey = await request(store, "/api/v1/inbox", { headers: apiHeaders() });
      expect(apiKey.status).toBe(401);
    });
  });

  describe("sharednet login", () => {
    async function startLogin(store: MemorySharedNetRepository, body: unknown = { label: "laptop" }) {
      const response = await request(store, "/api/v1/cli/logins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toContain("no-store");
      return json(response);
    }

    async function poll(store: MemorySharedNetRepository, loginId: string, token: string) {
      return request(store, `/api/v1/cli/logins/${loginId}/poll`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    }

    it("starts pending, answers pending until approved, then hands over one key that works", async () => {
      const store = makeStore();
      const started = await startLogin(store);
      expect(started.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(started.poll_token).toMatch(/^clp_[A-Za-z0-9_-]{43}$/);
      expect(started.verify_url).toBe(`http://127.0.0.1:3001/cli/authorize?code=${started.user_code}`);
      expect(started.login).toMatchObject({ state: "pending", label: "laptop", bind_instance_ids: [] });
      expect(started.login.id).toMatch(/^cli_[A-Za-z0-9]{10}$/);

      const pending = await poll(store, started.login.id, started.poll_token);
      expect(pending.status).toBe(200);
      expect((await json(pending)).state).toBe("pending");

      const host = await startInstance(store);
      const approved = await store.approveCliLogin({
        code: started.user_code,
        principalId: host.instance.principal_id,
      });
      expect(approved.login.state).toBe("approved");

      const handed = await poll(store, started.login.id, started.poll_token);
      expect(handed.status).toBe(200);
      const body = await json(handed);
      expect(body.state).toBe("approved");
      expect(body.api_key).toMatch(/^snk_[A-Za-z0-9_-]{43}$/);
      expect(body.api_key_id).toMatch(/^key_[A-Za-z0-9]{10}$/);
      expect(body.principal.id).toBe(host.instance.principal_id);

      // The key is real: it registers an Instance for that Principal.
      const registered = await request(store, "/api/v1/instances", {
        method: "POST",
        headers: { authorization: `Bearer ${body.api_key}`, "content-type": "application/json" },
        body: JSON.stringify({ runtime_kind: "claude-code", cli_version: "0.1.3" }),
      });
      expect(registered.status).toBe(201);
      expect((await json(registered)).instance.principal_id).toBe(host.instance.principal_id);

      // And it is handed over exactly once.
      const again = await poll(store, started.login.id, started.poll_token);
      expect(again.status).toBe(410);
      expect((await json(again)).error.code).toBe("login_consumed");
    });

    it("binds the anonymous seats the CLI proved it holds: the seat, its Room, and its history move to the account", async () => {
      const store = makeStore();
      const { host, room, principalId } = await openRoom(store);
      const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
      const guest = await store.joinRoomWithInvite(invite, room.id, { name: "claude-code" });
      await say(store, room.id, guest.member_token, "said while anonymous");
      const anonymousPrincipal = guest.membership.principal_id;
      expect(anonymousPrincipal).not.toBe(principalId);

      const other = await startInstance(store, { local_instance_key: OTHER_SESSION_KEY }, 201);
      void other;
      const started = await startLogin(store, { label: "laptop", seats: [guest.member_token, `sni_${"z".repeat(43)}`] });
      expect(started.login.bind_instance_ids).toEqual([guest.membership.member_id]);

      // The Room's host approves as itself: the anonymous Principal folds into it.
      const approved = await store.approveCliLogin({ code: started.user_code, principalId });
      expect(approved.bound_principal_ids).toEqual([anonymousPrincipal]);

      const detail = await request(store, `/api/v1/rooms/${room.id}`, {
        headers: instanceHeaders(host.token),
      });
      const seat = (await json(detail)).memberships.find((m: any) => m.member_id === guest.membership.member_id);
      expect(seat.principal_id).toBe(principalId);
      // Kind follows the Principal: bound, the seat is an Instance of the account.
      expect(seat.kind).toBe("instance");
      expect(seat.admitted_by).toBe("invite");
      expect(seat.name).toBe("claude-code");
      const page = await json(
        await request(store, `/api/v1/rooms/${room.id}/messages?after=0`, { headers: instanceHeaders(host.token) }),
      );
      const message = page.items.find((m: any) => m.content === "said while anonymous");
      expect(message.sender_principal_id).toBe(principalId);
      expect(message.sender_instance_id).toBe(guest.membership.member_id);

      // The seat's own token still works, now as the account's Instance.
      const stillSpeaks = await say(store, room.id, guest.member_token, "and after binding");
      expect(stillSpeaks.status).toBe(201);
      expect((await json(stillSpeaks)).message.sender_principal_id).toBe(principalId);

      // Binding is one-way: a second login naming the same seat binds nothing new.
      const second = await startLogin(store, { seats: [guest.member_token] });
      expect(second.login.bind_instance_ids).toEqual([]);
    });

    it("refuses a wrong poll token, an unknown code, an expired login, and a second approval", async () => {
      let tick = Date.parse("2026-09-06T10:00:00.000Z");
      const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => new Date(tick) });
      const started = await startLogin(store);

      const wrongToken = await poll(store, started.login.id, `clp_${"w".repeat(43)}`);
      expect(wrongToken.status).toBe(404);
      const notAToken = await poll(store, started.login.id, "sni_notapolltoken");
      expect(notAToken.status).toBe(401);
      const host = await startInstance(store);
      await expect(
        store.approveCliLogin({ code: "ZZZZ-ZZZZ", principalId: host.instance.principal_id }),
      ).rejects.toMatchObject({ code: "login_not_found" });

      tick += 11 * 60_000;
      const expired = await poll(store, started.login.id, started.poll_token);
      expect(expired.status).toBe(410);
      expect((await json(expired)).error.code).toBe("login_expired");
      await expect(
        store.approveCliLogin({ code: started.user_code, principalId: host.instance.principal_id }),
      ).rejects.toMatchObject({ code: "login_expired" });

      const fresh = await startLogin(store);
      await store.approveCliLogin({ code: fresh.user_code, principalId: host.instance.principal_id });
      await expect(
        store.approveCliLogin({ code: fresh.user_code, principalId: host.instance.principal_id }),
      ).rejects.toMatchObject({ code: "login_consumed" });
    });
  });
});

describe("credits: a purse per Principal, a ledger of every movement", () => {
  const ALICE = `snk_${"c".repeat(43)}`;
  const BOB = `snk_${"d".repeat(43)}`;
  const CAROL = `snk_${"e".repeat(43)}`;

  /** Three accounts with keys, one code worth 100 that two of them may redeem, one that has expired. */
  function creditStore() {
    return new MemorySharedNetRepository({
      now: () => new Date("2026-09-12T10:00:00.000Z"),
      accounts: [
        { authUserId: "alice", apiKey: ALICE },
        { authUserId: "bob", apiKey: BOB },
        { authUserId: "carol", apiKey: CAROL },
      ],
      creditCodes: [
        { code: "HACK-2026", amount: 100, max_redemptions: 2 },
        { code: "LASTYEAR", amount: 50, expires_at: "2026-09-01T00:00:00.000Z" },
      ],
    });
  }

  async function seat(store: MemorySharedNetRepository, key: string) {
    const { instance, token } = await startWithKey(store, key, { runtime_kind: "claude-code" });
    return { instanceId: instance.id as string, token: token as string, principalId: instance.principal_id as string };
  }

  function post(store: MemorySharedNetRepository, path: string, token: string, body: unknown, extra: Record<string, string> = {}) {
    return request(store, path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  }

  it("redeems a code once per account, caps it, refuses an anonymous seat, and refuses an expired one", async () => {
    const store = creditStore();

    const first = await post(store, "/api/v1/credits/redeem", ALICE, { code: "hack-2026" });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    const firstBody = await json(first);
    expect(firstBody.granted).toBe(100);
    expect(firstBody.credits).toMatchObject({ balance: 100, granted: 100, sent: 0, received: 0 });
    expect(firstBody.transfer).toMatchObject({ from_principal_id: null, amount: 100, code: "HACK-2026", by_instance_id: null });

    // A retry is not cheating: the purse is unchanged and nothing was granted.
    const again = await json(await post(store, "/api/v1/credits/redeem", ALICE, { code: "HACK-2026" }));
    expect(again).toMatchObject({ granted: 0, transfer: null, credits: { balance: 100 } });

    // Two redemptions were allowed; the third account is told the code is spent.
    expect((await json(await post(store, "/api/v1/credits/redeem", BOB, { code: "HACK-2026" }))).granted).toBe(100);
    const exhausted = await post(store, "/api/v1/credits/redeem", CAROL, { code: "HACK-2026" });
    expect(exhausted.status).toBe(410);
    expect((await json(exhausted)).error.code).toBe("credit_code_exhausted");

    const expired = await post(store, "/api/v1/credits/redeem", CAROL, { code: "LASTYEAR" });
    expect(expired.status).toBe(410);
    expect((await json(expired)).error.code).toBe("credit_code_expired");
    const unknown = await post(store, "/api/v1/credits/redeem", CAROL, { code: "NOPE" });
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).error.code).toBe("credit_code_not_found");
    expect((await post(store, "/api/v1/credits/redeem", CAROL, { code: "" })).status).toBe(422);
    expect((await post(store, "/api/v1/credits/redeem", CAROL, { code: "x", extra: 1 })).status).toBe(422);
    expect((await post(store, "/api/v1/credits/redeem", CAROL, { code: "HACK-2026" }, { "idempotency-key": crypto.randomUUID() })).status).toBe(400);

    // An anonymous Principal is free to create, so it may hold credits but never redeem a code.
    const alice = await seat(store, ALICE);
    const opened = await json(await post(store, "/api/v1/rooms", alice.token, { name: "Trade" }, { "idempotency-key": crypto.randomUUID() }));
    const invite = await json(
      await request(store, `/api/v1/rooms/${opened.room.id}/invites`, { method: "POST", headers: instanceHeaders(alice.token) }),
    );
    const guest = await json(
      await post(store, `/api/v1/rooms/${opened.room.id}/join`, invite.token, { name: "stranger", runtime: { kind: "curl" } }),
    );
    const refused = await post(store, "/api/v1/credits/redeem", guest.member_token, { code: "HACK-2026" });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe("credits_account_required");
  });

  it("keeps a settled redemption settled after the code expires, and measures a memo the way the column does", async () => {
    const clock = { now: new Date("2026-09-12T10:00:00.000Z") };
    const store = new MemorySharedNetRepository({
      now: () => clock.now,
      accounts: [{ authUserId: "alice", apiKey: ALICE }, { authUserId: "bob", apiKey: BOB }],
      creditCodes: [{ code: "SOON", amount: 10, expires_at: "2026-09-12T11:00:00.000Z" }],
    });

    expect((await json(await post(store, "/api/v1/credits/redeem", ALICE, { code: "SOON" }))).granted).toBe(10);
    clock.now = new Date("2026-09-12T12:00:00.000Z");
    // What this account already redeemed is history; the expiry does not unsettle it.
    expect((await json(await post(store, "/api/v1/credits/redeem", ALICE, { code: "SOON" }))).granted).toBe(0);
    // Someone who never redeemed it is told the truth.
    const late = await post(store, "/api/v1/credits/redeem", BOB, { code: "SOON" });
    expect(late.status).toBe(410);
    expect((await json(late)).error.code).toBe("credit_code_expired");

    // A memo is measured after NFKC, because that is what gets stored: "ﬃ"
    // is one character on the way in and three on the way out.
    const alice = await seat(store, ALICE);
    const bob = await seat(store, BOB);
    const expanding = "\uFB03".repeat(100);
    const refused = await post(
      store,
      "/api/v1/credits/transfers",
      alice.token,
      { to: bob.principalId, amount: 1, memo: expanding },
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(refused.status).toBe(422);
    const accepted = await post(
      store,
      "/api/v1/credits/transfers",
      alice.token,
      { to: bob.principalId, amount: 1, memo: "\uFB03".repeat(60) },
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(accepted.status).toBe(201);
    expect((await json(accepted)).transfer.memo).toBe("ffi".repeat(60));
  });

  it("follows a claimed seat to the account that claimed it, on both sides of a payment", async () => {
    const store = creditStore();
    await post(store, "/api/v1/credits/redeem", ALICE, { code: "HACK-2026" });
    const alice = await seat(store, ALICE);
    const opened = await json(await post(store, "/api/v1/rooms", alice.token, { name: "Trade" }, { "idempotency-key": crypto.randomUUID() }));
    const invite = await json(
      await request(store, `/api/v1/rooms/${opened.room.id}/invites`, { method: "POST", headers: instanceHeaders(alice.token) }),
    );
    const guest = await json(
      await post(store, `/api/v1/rooms/${opened.room.id}/join`, invite.token, { name: "stranger", runtime: { kind: "curl" } }),
    );
    // The guest is paid while it is still anonymous.
    await post(store, "/api/v1/credits/transfers", alice.token, { to: guest.membership.member_id, amount: 20 }, { "idempotency-key": crypto.randomUUID() });
    expect((await json(await request(store, "/api/v1/credits", { headers: instanceHeaders(guest.member_token) }))).credits.balance).toBe(20);

    // Its human logs in on that machine and claims the seat for Bob's account.
    const login = await json(
      await request(store, "/api/v1/cli/logins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "guest laptop", seats: [guest.member_token] }),
      }),
    );
    await store.approveCliLogin({ code: login.user_code, principalId: (await store.principalForAccount("bob"))!.id });

    // The same token now spends Bob's purse, and Bob's purse holds what the guest was paid.
    const afterClaim = await json(await request(store, "/api/v1/credits", { headers: instanceHeaders(guest.member_token) }));
    expect(afterClaim.credits).toMatchObject({ balance: 20, received: 20 });
    expect((await json(await request(store, "/api/v1/credits", { headers: apiHeaders({}, BOB) }))).credits.balance).toBe(20);
    // And paying that seat's id now reaches Bob, not the Principal it was born under.
    const paid = await json(
      await post(store, "/api/v1/credits/transfers", alice.token, { to: guest.membership.member_id, amount: 5 }, { "idempotency-key": crypto.randomUUID() }),
    );
    expect(paid.transfer.to_principal_id).toBe((await store.principalForAccount("bob"))!.id);
  });

  it("keeps one payment replay across guest claim and refuses a changed body", async () => {
    const store = creditStore();
    await post(store, "/api/v1/credits/redeem", ALICE, { code: "HACK-2026" });
    const alice = await seat(store, ALICE);
    const bob = await seat(store, BOB);
    const aliceAuth = await store.authenticateInstance(alice.token);
    const { room } = await store.createRoom(aliceAuth!, { name: "Replay after claim" });
    const invite = await store.createRoomInvite({ roomId: room.id, principalId: aliceAuth!.principalId });
    const guest = await store.joinRoomWithInvite(invite.token, room.id, { name: "payer" });
    await post(store, "/api/v1/credits/transfers", ALICE, { to: guest.membership.instance_id, amount: 20 }, { "idempotency-key": crypto.randomUUID() });
    const key = crypto.randomUUID();
    const body = { to: alice.principalId, amount: 7 };
    const first = await post(store, "/api/v1/credits/transfers", guest.member_token, body, { "idempotency-key": key });
    const firstText = await first.text();
    expect(first.status).toBe(201);
    const login = await store.startCliLogin({ label: "payer", seats: [guest.member_token] });
    await store.approveCliLogin({ code: login.user_code, principalId: (await store.principalForAccount("bob"))!.id });

    const replay = await post(store, "/api/v1/credits/transfers", guest.member_token, body, { "idempotency-key": key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.text()).toBe(firstText);
    const conflict = await post(store, "/api/v1/credits/transfers", guest.member_token, { ...body, amount: 8 }, { "idempotency-key": key });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe("idempotency_conflict");
    expect((await json(await request(store, "/api/v1/credits", { headers: apiHeaders({}, BOB) }))).credits.balance).toBe(13);

    // A second Instance of the same account owns a separate replay namespace.
    const independent = await post(store, "/api/v1/credits/transfers", bob.token, body, { "idempotency-key": key });
    expect(independent.status).toBe(201);
    expect(independent.headers.get("idempotency-replayed")).toBeNull();
    expect((await json(await request(store, "/api/v1/credits", { headers: apiHeaders({}, BOB) }))).credits.balance).toBe(6);
  });

  it("retains the Principal namespace for account-key idempotency", async () => {
    const store = creditStore();
    const alice = (await store.authenticateApiKey(ALICE))!;
    const bob = (await store.authenticateApiKey(BOB))!;
    const key = crypto.randomUUID();
    const scope = { principalId: alice.principalId, credentialClass: alice.kind, actorId: alice.actorId, operationId: "scope-contract", key };
    const first = await store.executeIdempotent(scope, "same-body", async () => ({ status: 201, body: "first Principal" }));
    const second = await store.executeIdempotent({ ...scope, principalId: bob.principalId }, "same-body", async () => ({ status: 201, body: "second Principal" }));
    expect(first).toMatchObject({ replayed: false, body: "first Principal" });
    expect(second).toMatchObject({ replayed: false, body: "second Principal" });
  });

  it("pays by Principal, Agent or Instance id, exactly once per key, never more than the purse holds, never to itself", async () => {
    const store = creditStore();
    await post(store, "/api/v1/credits/redeem", ALICE, { code: "HACK-2026" });
    const alice = await seat(store, ALICE);
    const bob = await seat(store, BOB);
    const { agent: bobsTag } = await (async () => {
      const response = await request(store, "/api/v1/agents", {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }, BOB),
        body: JSON.stringify({ handle: "bob-bot" }),
      });
      return json(response);
    })();

    const key = crypto.randomUUID();
    const body = { to: bob.instanceId, amount: 30, memo: "map tiles" };
    const paid = await post(store, "/api/v1/credits/transfers", alice.token, body, { "idempotency-key": key });
    expect(paid.status).toBe(201);
    const paidBody = await json(paid);
    expect(paidBody.transfer).toMatchObject({
      from_principal_id: alice.principalId,
      to_principal_id: bob.principalId,
      amount: 30,
      memo: "map tiles",
      by_instance_id: alice.instanceId,
      addressed_to: bob.instanceId,
      code: null,
    });
    expect(paidBody.credits).toMatchObject({ balance: 70, granted: 100, sent: 30, received: 0 });

    const replay = await post(store, "/api/v1/credits/transfers", alice.token, body, { "idempotency-key": key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await json(replay)).toEqual(paidBody);
    expect((await json(await request(store, "/api/v1/credits", { headers: apiHeaders({}, ALICE) }))).credits.balance).toBe(70);

    // The same purse answers to the account key, which pays with no seat behind it.
    const byKey = await post(store, "/api/v1/credits/transfers", ALICE, { to: bobsTag.id, amount: 5 }, { "idempotency-key": crypto.randomUUID() });
    expect((await json(byKey)).transfer).toMatchObject({ to_principal_id: bob.principalId, by_instance_id: null, addressed_to: bobsTag.id });
    const byPrincipal = await post(store, "/api/v1/credits/transfers", ALICE, { to: bob.principalId, amount: 5 }, { "idempotency-key": crypto.randomUUID() });
    expect(byPrincipal.status).toBe(201);
    expect((await json(await request(store, "/api/v1/credits", { headers: instanceHeaders(bob.token) }))).credits).toMatchObject({ balance: 40, received: 40, granted: 0, sent: 0 });

    const tooMuch = await post(store, "/api/v1/credits/transfers", alice.token, { to: bob.principalId, amount: 61 }, { "idempotency-key": crypto.randomUUID() });
    expect(tooMuch.status).toBe(409);
    expect((await json(tooMuch)).error.code).toBe("insufficient_credits");
    const nobody = await post(store, "/api/v1/credits/transfers", alice.token, { to: "i_nobody0001", amount: 1 }, { "idempotency-key": crypto.randomUUID() });
    expect(nobody.status).toBe(404);
    expect((await json(nobody)).error.code).toBe("payee_not_found");
    const self = await post(store, "/api/v1/credits/transfers", alice.token, { to: alice.instanceId, amount: 1 }, { "idempotency-key": crypto.randomUUID() });
    expect(self.status).toBe(422);
    expect((await json(self)).error.code).toBe("transfer_to_self");
    expect((await post(store, "/api/v1/credits/transfers", alice.token, { to: bob.principalId, amount: 1 })).status).toBe(400);
    expect((await post(store, "/api/v1/credits/transfers", alice.token, { to: bob.principalId, amount: 1.5 }, { "idempotency-key": crypto.randomUUID() })).status).toBe(422);
    expect((await post(store, "/api/v1/credits/transfers", alice.token, { to: bob.principalId, amount: 1, memo: "x".repeat(201) }, { "idempotency-key": crypto.randomUUID() })).status).toBe(422);
    expect((await post(store, "/api/v1/credits/transfers", alice.token, { to: "rom_nowhere001", amount: 1 }, { "idempotency-key": crypto.randomUUID() })).status).toBe(422);
    expect((await request(store, "/api/v1/credits")).status).toBe(401);
    expect((await request(store, "/api/v1/credits", { headers: { authorization: `Bearer rit_${"t".repeat(43)}` } })).status).toBe(401);

    // The ledger, newest first, as each side reads it; paging by transfer id.
    const alicesLedger = await json(await request(store, "/api/v1/credits/transfers?limit=2", { headers: instanceHeaders(alice.token) }));
    expect(alicesLedger.items.map((t: { amount: number; code: string | null }) => [t.amount, t.code])).toEqual([[5, null], [5, null]]);
    expect(alicesLedger.has_more).toBe(true);
    const rest = await json(
      await request(store, `/api/v1/credits/transfers?limit=2&before=${alicesLedger.next_cursor}`, { headers: instanceHeaders(alice.token) }),
    );
    expect(rest.items.map((t: { amount: number; code: string | null }) => [t.amount, t.code])).toEqual([[30, null], [100, "HACK-2026"]]);
    expect(rest.has_more).toBe(false);
    const bobsLedger = await json(await request(store, "/api/v1/credits/transfers", { headers: apiHeaders({}, BOB) }));
    expect(bobsLedger.items.map((t: { amount: number }) => t.amount)).toEqual([5, 5, 30]);
    expect((await request(store, "/api/v1/credits/transfers?before=txn_nowhere001", { headers: apiHeaders({}, BOB) })).status).toBe(400);
    expect((await request(store, "/api/v1/credits/transfers?limit=0", { headers: apiHeaders({}, BOB) })).status).toBe(400);
  });
});

describe("artifacts: a file an Agent hands to the Room", () => {
  const OWNER = `snk_${"f".repeat(43)}`;
  const MEMBER = `snk_${"g".repeat(43)}`;
  const STRANGER = `snk_${"h".repeat(43)}`;

  /** The clock advances a second per read, so "newest first" is a real order. */
  function artifactStore() {
    let tick = 0;
    return new MemorySharedNetRepository({
      now: () => new Date(Date.parse("2026-09-12T10:00:00.000Z") + tick++ * 1000),
      accounts: [
        { authUserId: "owner", apiKey: OWNER },
        { authUserId: "member", apiKey: MEMBER },
        { authUserId: "stranger", apiKey: STRANGER },
      ],
    });
  }

  /** An owner's seat, a Room it opened, and a second account seated in it. */
  async function sharedRoom(store: MemorySharedNetRepository) {
    const owner = await startWithKey(store, OWNER, { runtime_kind: "claude-code" });
    const member = await startWithKey(store, MEMBER, { runtime_kind: "codex" });
    const ownerAuth = (await store.authenticateInstance(owner.token as string))!;
    const memberAuth = (await store.authenticateInstance(member.token as string))!;
    const { room } = await store.createRoom(ownerAuth, { name: "Handover" });
    await store.joinRoom(memberAuth, room.id);
    return { owner, member, ownerAuth, memberAuth, roomId: room.id as string };
  }

  function upload(
    store: MemorySharedNetRepository,
    token: string,
    bytes: string | Uint8Array,
    headers: Record<string, string>,
  ) {
    return request(store, "/api/v1/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID(), ...headers },
      body: bytes as BodyInit,
    });
  }

  it("hands a file to a Room: its members read it, a stranger is told it does not exist", async () => {
    const store = artifactStore();
    const { owner, member, roomId } = await sharedRoom(store);
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";

    const created = await upload(store, owner.token as string, patch, {
      "content-type": "text/plain; charset=utf-8",
      "x-sharednet-filename": "fix.patch",
      "x-sharednet-room": roomId,
    });
    expect(created.status).toBe(201);
    const createdBody = await json(created.clone());
    const { artifact } = createdBody;
    expect(artifact).toMatchObject({
      filename: "fix.patch",
      content_type: "text/plain",
      reach: "room",
      room_id: roomId,
      size_bytes: patch.length,
      uploaded_by_instance_id: (owner as { instance: { id: string } }).instance.id,
    });
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.id).toMatch(/^art_[0-9A-Za-z]{10}$/);
    // No link exists for a Room file, so none is handed out.
    expect(await json(created)).toEqual({ artifact });

    // The other member reads the bytes, as an attachment and nothing else.
    const content = await request(store, `/api/v1/artifacts/${artifact.id}/content`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(patch);
    expect(content.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''fix.patch");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("x-sharednet-sha256")).toBe(artifact.sha256);

    // An account with no seat in that Room cannot see that the file exists.
    for (const path of [`/api/v1/artifacts/${artifact.id}`, `/api/v1/artifacts/${artifact.id}/content`]) {
      const refused = await request(store, path, { headers: apiHeaders({}, STRANGER) });
      expect(refused.status).toBe(404);
      expect((await json(refused)).error.code).toBe("artifact_not_found");
    }
    // And only the uploader may remove it.
    expect((await request(store, `/api/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: { authorization: `Bearer ${member.token}` } })).status).toBe(404);
    const removed = await request(store, `/api/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: apiHeaders({}, OWNER) });
    expect(removed.status).toBe(200);
    expect((await request(store, `/api/v1/artifacts/${artifact.id}`, { headers: apiHeaders({}, OWNER) })).status).toBe(404);
  });

  it("refuses to hand a file to a Room the caller does not sit in, or to a closed one", async () => {
    const store = artifactStore();
    const { owner, roomId } = await sharedRoom(store);

    const notMine = await upload(store, STRANGER, "x", {
      "x-sharednet-filename": "x.txt",
      "x-sharednet-room": roomId,
    });
    expect(notMine.status).toBe(404);
    expect((await json(notMine)).error.code).toBe("room_not_found");

    await store.closeRoom((await store.principalForAccount("owner"))!.id, roomId as never);
    const closed = await upload(store, owner.token as string, "x", {
      "x-sharednet-filename": "x.txt",
      "x-sharednet-room": roomId,
    });
    expect(closed.status).toBe(409);
    expect((await json(closed)).error.code).toBe("room_closed");
  });

  it("opens a link file by its key alone, with no account, and refuses a wrong key the same way as a missing file", async () => {
    const store = artifactStore();
    const { owner } = await sharedRoom(store);

    const created = await upload(store, owner.token as string, "a,b\n1,2\n", {
      "content-type": "text/csv",
      "x-sharednet-filename": "rows.csv",
      "x-sharednet-reach": "link",
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body.link_key).toMatch(/^afk_[A-Za-z0-9_-]{43}$/);
    expect(body.url).toBe(`http://127.0.0.1:3001/f/${body.artifact.id}?k=${body.link_key}`);
    expect(body.artifact.reach).toBe("link");

    const opened = await request(store, `/api/v1/artifacts/${body.artifact.id}/content?k=${body.link_key}`);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe("a,b\n1,2\n");
    expect(opened.headers.get("content-type")).toBe("text/csv");

    const wrong = await request(store, `/api/v1/artifacts/${body.artifact.id}/content?k=afk_${"z".repeat(43)}`);
    expect(wrong.status).toBe(404);
    expect((await json(wrong)).error.code).toBe("artifact_not_found");
    expect((await request(store, `/api/v1/artifacts/${body.artifact.id}/content?k=nonsense`)).status).toBe(404);
    // A Room file has no link, so its key cannot be guessed into existence.
    const roomFile = await json(
      await upload(store, owner.token as string, "x", { "x-sharednet-filename": "x.txt", "x-sharednet-room": (await sharedRoom(store)).roomId }),
    );
    expect((await request(store, `/api/v1/artifacts/${roomFile.artifact.id}/content?k=afk_${"y".repeat(43)}`)).status).toBe(404);
    // And a reader with the key still cannot reach the account's other files.
    expect((await request(store, `/api/v1/artifacts/${body.artifact.id}`)).status).toBe(401);
  });

  it("serves anything that could run in a browser as bytes, never inline", async () => {
    const store = artifactStore();
    const { owner } = await sharedRoom(store);
    for (const [type, filename] of [
      ["text/html", "page.html"],
      ["image/svg+xml", "logo.svg"],
      ["application/javascript", "script.js"],
    ]) {
      const created = await json(
        await upload(store, owner.token as string, "<script>alert(1)</script>", {
          "content-type": type!,
          "x-sharednet-filename": filename!,
          "x-sharednet-reach": "link",
        }),
      );
      const served = await request(store, `/api/v1/artifacts/${created.artifact.id}/content?k=${created.link_key}`);
      expect(served.headers.get("content-type")).toBe("application/octet-stream");
      expect(served.headers.get("content-disposition")).toContain("attachment");
      expect(served.headers.get("content-security-policy")).toContain("sandbox");
    }
  });

  it("refuses a filename that is a path, an empty body, and a file over the limit", async () => {
    const store = artifactStore();
    const { owner, roomId } = await sharedRoom(store);
    const bad = { "x-sharednet-room": roomId };

    for (const filename of ["../../etc/passwd", "a/b.txt", "b\\c.txt", ".", "..", "", "x".repeat(121)]) {
      const refused = await upload(store, owner.token as string, "x", { ...bad, "x-sharednet-filename": filename });
      expect(refused.status).toBe(422);
    }
    expect((await upload(store, owner.token as string, "x", bad)).status).toBe(422);
    expect((await upload(store, owner.token as string, "", { ...bad, "x-sharednet-filename": "empty.txt" })).status).toBe(422);
    // Reach `room` needs a Room; reach `link` does not want one.
    expect((await upload(store, owner.token as string, "x", { "x-sharednet-filename": "x.txt" })).status).toBe(422);
    expect((await upload(store, owner.token as string, "x", { ...bad, "x-sharednet-filename": "x.txt", "x-sharednet-reach": "everyone" })).status).toBe(422);

    const tooBig = new Uint8Array(4 * 1024 * 1024 + 1);
    tooBig.fill(65);
    const refused = await upload(store, owner.token as string, tooBig, { ...bad, "x-sharednet-filename": "big.bin" });
    expect(refused.status).toBe(413);
    expect((await json(refused)).error.code).toBe("artifact_too_large");
  });

  it("lists what the caller may read, newest first, and replays an upload that carried the same key", async () => {
    const store = artifactStore();
    const { owner, member, roomId } = await sharedRoom(store);
    const names = ["one.txt", "two.txt", "three.txt"];
    for (const filename of names) {
      expect((await upload(store, owner.token as string, filename, { "x-sharednet-filename": filename, "x-sharednet-room": roomId })).status).toBe(201);
    }
    // A private file of the owner's, which the member must not see.
    await upload(store, owner.token as string, "secret", { "x-sharednet-filename": "private.txt", "x-sharednet-reach": "private" });

    const ownerList = await json(await request(store, "/api/v1/artifacts", { headers: apiHeaders({}, OWNER) }));
    expect(ownerList.items.map((item: { filename: string }) => item.filename)).toEqual(["private.txt", "three.txt", "two.txt", "one.txt"]);
    const memberList = await json(await request(store, "/api/v1/artifacts", { headers: { authorization: `Bearer ${member.token}` } }));
    expect(memberList.items.map((item: { filename: string }) => item.filename)).toEqual(["three.txt", "two.txt", "one.txt"]);
    const paged = await json(await request(store, "/api/v1/artifacts?limit=2", { headers: { authorization: `Bearer ${member.token}` } }));
    expect(paged.has_more).toBe(true);
    const rest = await json(
      await request(store, `/api/v1/artifacts?limit=2&before=${paged.next_cursor}`, { headers: { authorization: `Bearer ${member.token}` } }),
    );
    expect(rest.items.map((item: { filename: string }) => item.filename)).toEqual(["one.txt"]);
    expect((await request(store, "/api/v1/artifacts?before=art_nowhere01", { headers: apiHeaders({}, OWNER) })).status).toBe(400);
    expect((await request(store, `/api/v1/artifacts?room_id=${roomId}`, { headers: apiHeaders({}, STRANGER) }))).toBeTruthy();

    // One key, one file: a retried upload does not store the bytes twice.
    const key = crypto.randomUUID();
    const headers = { authorization: `Bearer ${owner.token}`, "idempotency-key": key, "x-sharednet-filename": "once.txt", "x-sharednet-room": roomId };
    const first = await request(store, "/api/v1/artifacts", { method: "POST", headers, body: "once" });
    const replay = await request(store, "/api/v1/artifacts", { method: "POST", headers, body: "once" });
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect((await json(replay)).artifact.id).toBe((await json(first)).artifact.id);
    // A different file under the same key is a conflict, not a second upload.
    const conflict = await request(store, "/api/v1/artifacts", { method: "POST", headers, body: "twice" });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe("idempotency_conflict");
    expect((await request(store, "/api/v1/artifacts", { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "x-sharednet-filename": "x.txt", "x-sharednet-room": roomId }, body: "x" })).status).toBe(400);
  });
  it("keeps every guest file manageable by the claiming account, including the original upload replay", async () => {
    const store = artifactStore();
    const { ownerAuth, memberAuth, roomId } = await sharedRoom(store);
    const { token } = await store.createRoomInvite({ roomId: roomId as `rom_${string}`, principalId: ownerAuth.principalId });
    const guest = await store.joinRoomWithInvite(token, roomId as `rom_${string}`, { name: "file author", runtime: { kind: "curl" } });
    const guestAuth = (await store.authenticateInstance(guest.member_token))!;
    const files = [];
    for (const reach of ["private", "room", "link"] as const) {
      const headers = {
        authorization: `Bearer ${guest.member_token}`,
        "idempotency-key": crypto.randomUUID(),
        "x-sharednet-filename": `${reach}.txt`,
        "x-sharednet-reach": reach,
        ...(reach === "room" ? { "x-sharednet-room": roomId } : {}),
      };
      const response = await request(store, "/api/v1/artifacts", { method: "POST", headers, body: "guest file" });
      expect(response.status).toBe(201);
      const body = await response.text();
      const decoded = JSON.parse(body) as { artifact: { id: `art_${string}` }; link_key?: string };
      files.push({ reach, headers, body, ...decoded });
    }
    expect(await store.artifactUsage(guestAuth)).toMatchObject({ bytes: 30, count: 3 });
    const login = await store.startCliLogin({ label: "file author", seats: [guest.member_token] });
    await store.approveCliLogin({ code: login.user_code, principalId: ownerAuth.principalId });
    const claimed = (await store.authenticateInstance(guest.member_token))!;
    expect(claimed.principalId).toBe(ownerAuth.principalId);
    expect(await store.artifactUsage(claimed)).toMatchObject({ bytes: 30, count: 3 });
    expect((await store.listArtifacts(claimed, { room_id: null, before: null, limit: 50 })).items).toHaveLength(3);
    for (const file of files) {
      const read = await store.readArtifact(claimed, file.artifact.id);
      expect(new TextDecoder().decode(read.bytes)).toBe("guest file");
      expect(read.artifact.principal_id).toBe(ownerAuth.principalId);
      await expect(store.deleteArtifact(memberAuth, file.artifact.id)).rejects.toMatchObject({ code: "artifact_not_found" });
      if (file.reach !== "room") await expect(store.readArtifact(memberAuth, file.artifact.id)).rejects.toMatchObject({ code: "artifact_not_found" });
      const replay = await request(store, "/api/v1/artifacts", { method: "POST", headers: file.headers, body: "guest file" });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(await replay.text()).toBe(file.body);
      const conflict = await request(store, "/api/v1/artifacts", { method: "POST", headers: file.headers, body: "changed" });
      expect(conflict.status).toBe(409);
      expect((await json(conflict)).error.code).toBe("idempotency_conflict");
    }
    expect(await store.artifactUsage(claimed)).toMatchObject({ bytes: 30, count: 3 });
    for (const file of files) {
      expect((await store.deleteArtifact(claimed, file.artifact.id)).artifact.principal_id).toBe(ownerAuth.principalId);
      if (file.link_key) await expect(store.readArtifactByLink(file.artifact.id, file.link_key)).rejects.toMatchObject({ code: "artifact_not_found" });
    }
    expect(await store.artifactUsage(claimed)).toMatchObject({ bytes: 0, count: 0 });
  });

  it("charges an upload authenticated before a finished guest claim to the current account", async () => {
    const store = artifactStore();
    const { ownerAuth, roomId } = await sharedRoom(store);
    const { token } = await store.createRoomInvite({ roomId: roomId as `rom_${string}`, principalId: ownerAuth.principalId });
    const guest = await store.joinRoomWithInvite(token, roomId as `rom_${string}`, { name: "late upload", runtime: { kind: "curl" } });
    const staleAuth = (await store.authenticateInstance(guest.member_token))!;
    const login = await store.startCliLogin({ label: "late upload", seats: [guest.member_token] });
    await store.approveCliLogin({ code: login.user_code, principalId: ownerAuth.principalId });
    const uploaded = await store.uploadArtifact(staleAuth, { filename: "late.txt", reach: "private", room_id: null, content_type: "text/plain", bytes: new TextEncoder().encode("late") });
    expect(uploaded.artifact.principal_id).toBe(ownerAuth.principalId);
    expect(await store.artifactUsage(ownerAuth)).toMatchObject({ bytes: 4, count: 1 });
    expect((await store.readArtifact(ownerAuth, uploaded.artifact.id)).artifact.id).toBe(uploaded.artifact.id);
  });

});

