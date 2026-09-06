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
};

async function startInstance(
  store: MemorySharedNetRepository,
  body: StartBody = {},
  expectedStatus: 200 | 201 = 201,
) {
  const response = await request(store, "/api/v1/instances", {
    method: "POST",
    headers: apiHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.0", ...body }),
  });
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("cache-control")).toContain("no-store");
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
        cli_version: "0.1.0",
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
        body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.0", ...body }),
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
      body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.0" }),
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

  async function startAs(store: MemorySharedNetRepository, key: string) {
    const response = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }, key),
      body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.0" }),
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
});
