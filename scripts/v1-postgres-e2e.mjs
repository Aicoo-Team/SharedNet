import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import pg from "pg";

const { Client } = pg;
const root = resolve(import.meta.dirname, "..");
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required and must point to a disposable PostgreSQL database.",
  );
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
if (!/(^|[_-])(test|e2e)([_-]|$)/i.test(databaseName)) {
  throw new Error(
    "TEST_DATABASE_URL must name an explicitly disposable database containing `test` or `e2e`.",
  );
}

const sandbox = await mkdtemp(join(tmpdir(), "sharednet-v1-postgres-e2e-"));
const baseURL = "http://127.0.0.1:3001";
const email = `v1-e2e-${randomBytes(8).toString("hex")}@example.test`;
const password = `test-${randomBytes(24).toString("base64url")}`;
const secret = randomBytes(32).toString("hex");

process.env.DATABASE_URL = databaseUrl;
process.env.DATABASE_URL_UNPOOLED = databaseUrl;
process.env.BETTER_AUTH_URL = baseURL;
process.env.BETTER_AUTH_SECRET = secret;
delete process.env.SHAREDNET_DEV_API_KEY;

// The harness owns its database. Dropping the schemas first makes a run
// identical whether the database is fresh (CI) or reused (a developer's
// laptop), and it is the name guard above that makes this safe to do.
{
  const reset = new Client({ connectionString: databaseUrl });
  await reset.connect();
  try {
    await reset.query(
      "DROP SCHEMA IF EXISTS sharednet, sharednet_auth, sharednet_migrations CASCADE",
    );
  } finally {
    await reset.end();
  }
}

const { migrateDatabase } = await import("../packages/db/src/migrate.ts");
await migrateDatabase({ connectionString: databaseUrl });

const { getAuth } = await import("../lib/auth.ts");
const auth = getAuth();

async function authRequest(path, body, cookie) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseURL,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} returned ${response.status}: ${await response.text()}`);
  }
}

const signUpResponse = await authRequest("/sign-up/email", {
  email,
  name: "V1 Postgres E2E",
  password,
});
await assertStatus(signUpResponse, 200, "sign-up");

const signInResponse = await authRequest("/sign-in/email", { email, password });
await assertStatus(signInResponse, 200, "sign-in");
const sessionCookie = signInResponse.headers.get("set-cookie")?.split(";", 1)[0];
assert.ok(sessionCookie, "sign-in must return a session cookie");

const sessionResponse = await auth.handler(
  new Request(`${baseURL}/api/auth/get-session`, {
    headers: { cookie: sessionCookie },
  }),
);
await assertStatus(sessionResponse, 200, "get-session");
const sessionPayload = await sessionResponse.json();
assert.equal(sessionPayload.user.email, email);

const keyResponse = await authRequest(
  "/api-key/create",
  { name: "Four Codex E2E", prefix: "client_prefix_must_not_win_" },
  sessionCookie,
);
await assertStatus(keyResponse, 200, "create-api-key");
const keyPayload = await keyResponse.json();
assert.match(keyPayload.id, /^key_[0-9A-Za-z]{10}$/);
assert.match(keyPayload.key, /^snk_[A-Za-z0-9_-]{43}$/);
const apiKey = keyPayload.key;

const database = new Client({ connectionString: databaseUrl });
await database.connect();

const principalBeforeCli = await database.query(
  'SELECT id FROM sharednet.principal WHERE auth_user_id = $1',
  [sessionPayload.user.id],
);
assert.equal(
  principalBeforeCli.rowCount,
  1,
  "sign-up must provision exactly one Principal before the CLI first authenticates",
);

await database.query('DELETE FROM sharednet.principal WHERE auth_user_id = $1', [
  sessionPayload.user.id,
]);
const principalAfterSimulatedHookFailure = await database.query(
  'SELECT id FROM sharednet.principal WHERE auth_user_id = $1',
  [sessionPayload.user.id],
);
assert.equal(
  principalAfterSimulatedHookFailure.rowCount,
  0,
  "the recovery fixture must remove the initially provisioned Principal",
);

const storedKey = await database.query(
  'SELECT id, key FROM sharednet_auth.apikey WHERE id = $1',
  [keyPayload.id],
);
assert.equal(storedKey.rowCount, 1);
assert.notEqual(storedKey.rows[0].key, apiKey, "the raw API key must never be stored");

function spawnServer(port = 0) {
  const child = spawn(process.execPath, ["packages/server/src/dev-server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

function waitForServer(server) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`SharedNet V1 server did not start:\n${server.output()}`));
    }, 20_000);

    const inspect = () => {
      const match = server.output().match(
        /sharednet-v1 listening (http:\/\/127\.0\.0\.1:\d+)/,
      );
      if (!match) return;
      clearTimeout(timeout);
      cleanup();
      resolveReady(match[1]);
    };
    const exited = (code) => {
      clearTimeout(timeout);
      cleanup();
      rejectReady(
        new Error(`SharedNet V1 server exited ${code}:\n${server.output()}`),
      );
    };
    const cleanup = () => {
      server.child.stdout.off("data", inspect);
      server.child.stderr.off("data", inspect);
      server.child.off("exit", exited);
    };
    server.child.stdout.on("data", inspect);
    server.child.stderr.on("data", inspect);
    server.child.once("exit", exited);
  });
}

function stopServer(server) {
  return new Promise((resolveStop) => {
    if (server.child.exitCode !== null) {
      resolveStop();
      return;
    }
    server.child.once("exit", () => resolveStop());
    server.child.kill("SIGTERM");
  });
}

function runCli(baseUrl, args, sessionName) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["packages/cli/src/main.ts", ...args], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_SESSION_ID: sessionName,
        CODEX_THREAD_ID: "local-lineage-must-stay-local",
        SHAREDNET_API_KEY: apiKey,
        SHAREDNET_BASE_URL: baseUrl,
        XDG_CONFIG_HOME: join(sandbox, "config"),
        XDG_STATE_HOME: join(sandbox, "state"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      const combined = `${stdout}\n${stderr}`;
      assert.equal(combined.includes(apiKey), false, "API key leaked to CLI output");
      assert.equal(
        /sni_[A-Za-z0-9_-]{43}/.test(combined),
        false,
        "Instance token leaked to CLI output",
      );
      if (code !== 0) {
        rejectRun(
          new Error(`sharednet ${args.join(" ")} exited ${code}:\n${combined}`),
        );
        return;
      }
      try {
        resolveRun(JSON.parse(stdout));
      } catch (error) {
        rejectRun(
          new Error(`CLI did not return one JSON value: ${stdout}`, { cause: error }),
        );
      }
    });
  });
}

let server;
try {
  server = spawnServer();
  let apiBaseUrl = await waitForServer(server);
  const codexSessions = ["codex-alpha", "codex-beta", "codex-gamma", "codex-delta"];
  const starts = await Promise.all(
    codexSessions.map((name) =>
      runCli(apiBaseUrl, ["session", "start", "--json"], name),
    ),
  );

  const instanceIds = starts.map((value) => value.session_id);
  assert.equal(new Set(instanceIds).size, 4, "four Codex sessions must be four Instances");
  assert.equal(new Set(starts.map((value) => value.instance.agent_id)).size, 1);
  assert.equal(new Set(starts.map((value) => value.instance.principal_id)).size, 1);

  const expiredIdempotencyKey = randomUUID();
  await database.query(
    `INSERT INTO sharednet.idempotency_record (
      principal_id, credential_class, actor_id, operation_id,
      idempotency_key, request_fingerprint, response_status, response_body,
      created_at, expires_at
    ) VALUES ($1, 'instance', $2, 'expired-e2e-fixture', $3, $4, 200, '{}',
      now() - interval '25 hours', now() - interval '1 hour')`,
    [
      starts[0].instance.principal_id,
      instanceIds[0],
      expiredIdempotencyKey,
      "0".repeat(64),
    ],
  );

  const created = await runCli(
    apiBaseUrl,
    ["room", "create", "--name", "Four Codex Room", "--session", instanceIds[0], "--json"],
    codexSessions[0],
  );
  const roomId = created.room.id;
  const expiredIdempotencyRecord = await database.query(
    'SELECT 1 FROM sharednet.idempotency_record WHERE idempotency_key = $1',
    [expiredIdempotencyKey],
  );
  assert.equal(
    expiredIdempotencyRecord.rowCount,
    0,
    "a normal mutation must reclaim expired idempotency records",
  );

  await Promise.all(
    instanceIds.slice(1).map((instanceId, index) =>
      runCli(
        apiBaseUrl,
        ["room", "join", roomId, "--session", instanceId, "--json"],
        codexSessions[index + 1],
      ),
    ),
  );

  await Promise.all(
    instanceIds.map((instanceId, index) =>
      runCli(
        apiBaseUrl,
        [
          "room",
          "post",
          roomId,
          "--content",
          `hello from local Codex ${index + 1}`,
          "--session",
          instanceId,
          "--json",
        ],
        codexSessions[index],
      ),
    ),
  );

  const restartPort = Number(new URL(apiBaseUrl).port);
  await stopServer(server);
  server = spawnServer(restartPort);
  apiBaseUrl = await waitForServer(server);

  const resumed = await Promise.all(
    codexSessions.map((name) =>
      runCli(apiBaseUrl, ["session", "start", "--json"], name),
    ),
  );
  assert.deepEqual(
    resumed.map((value) => value.session_id),
    instanceIds,
    "Instance Computation must resume the same four registered Instances",
  );

  const views = await Promise.all(
    instanceIds.map((instanceId, index) =>
      runCli(
        apiBaseUrl,
        ["room", "messages", roomId, "--session", instanceId, "--json"],
        codexSessions[index],
      ),
    ),
  );

  for (const view of views) {
    assert.deepEqual(view.items.map((message) => message.sequence), [1, 2, 3, 4]);
    assert.deepEqual(
      new Set(view.items.map((message) => message.sender_instance_id)),
      new Set(instanceIds),
    );
  }

  // --- A guest joins by invite over plain HTTP: no CLI, no account key. ---
  // The Web mints the invite through the repository; here the harness does.
  const { createDatabase, createDatabasePool } = await import("../packages/db/src/index.ts");
  const { PostgresSharedNetRepository } = await import(
    "../packages/server/src/postgres-repository.ts"
  );
  const invitePool = createDatabasePool({ connectionString: databaseUrl });
  const repository = new PostgresSharedNetRepository(createDatabase(invitePool));
  const { invite, token: inviteToken } = await repository.createRoomInvite({
    roomId,
    principalId: starts[0].instance.principal_id,
  });
  assert.match(inviteToken, /^rit_[A-Za-z0-9_-]{43}$/);
  assert.equal(invite.expires_at, null, "an invite never expires unless asked to");

  const joinResponse = await fetch(`${apiBaseUrl}/api/v1/rooms/${roomId}/join`, {
    method: "POST",
    headers: { authorization: `Bearer ${inviteToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "claude-code" }),
  });
  await assertStatus(joinResponse, 200, "guest-join");
  const joined = await joinResponse.json();
  assert.match(joined.member_token, /^rmt_[A-Za-z0-9_-]{43}$/);
  assert.equal(joined.membership.kind, "guest");
  assert.equal(joined.membership.name, "claude-code");
  assert.equal(joined.membership.presence, "online");
  assert.deepEqual(
    joined.history.items.map((message) => message.sequence),
    [1, 2, 3, 4],
    "a guest catches up on the whole history in the join call",
  );

  const guestSaid = await fetch(`${apiBaseUrl}/api/v1/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${joined.member_token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "hello from a guest with curl" }),
  });
  await assertStatus(guestSaid, 201, "guest-post");
  const guestMessage = (await guestSaid.json()).message;
  assert.equal(guestMessage.sequence, 5);
  assert.deepEqual(guestMessage.sender, {
    member_id: joined.membership.member_id,
    kind: "guest",
    name: "claude-code",
  });

  // --- The inbox: every Room the caller sits in, oldest first, opaque cursor. ---
  const inboxFirst = await fetch(`${apiBaseUrl}/api/v1/inbox?limit=3`, {
    headers: { authorization: `Bearer ${joined.member_token}` },
  });
  await assertStatus(inboxFirst, 200, "inbox-first-page");
  const firstPage = await inboxFirst.json();
  assert.deepEqual(firstPage.items.map((message) => message.sequence), [1, 2, 3]);
  assert.equal(firstPage.has_more, true);
  assert.match(firstPage.next_cursor, /^ibx_[A-Za-z0-9_-]+$/);
  const inboxRest = await fetch(
    `${apiBaseUrl}/api/v1/inbox?after=${encodeURIComponent(firstPage.next_cursor)}`,
    { headers: { authorization: `Bearer ${joined.member_token}` } },
  );
  await assertStatus(inboxRest, 200, "inbox-rest");
  const restPage = await inboxRest.json();
  assert.deepEqual(
    restPage.items.map((message) => message.sequence),
    [4, 5],
    "the inbox resumes exactly after the cursor, across a real database",
  );
  assert.equal(restPage.has_more, false);
  const inboxBadCursor = await fetch(`${apiBaseUrl}/api/v1/inbox?after=5`, {
    headers: { authorization: `Bearer ${joined.member_token}` },
  });
  await assertStatus(inboxBadCursor, 400, "inbox-bad-cursor");
  assert.equal(guestMessage.sender_instance_id, null);

  const hostView = await runCli(
    apiBaseUrl,
    ["room", "messages", roomId, "--session", instanceIds[0], "--json"],
    codexSessions[0],
  );
  assert.equal(hostView.items.at(-1).sender.name, "claude-code", "an Instance sees the guest by name");

  // The guest sits in the Room; the host speaks; wait answers with exactly that.
  const waiting = fetch(`${apiBaseUrl}/api/v1/rooms/${roomId}/wait?after=5&timeout=10`, {
    headers: { authorization: `Bearer ${joined.member_token}` },
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  await runCli(
    apiBaseUrl,
    ["room", "post", roomId, "--content", "you there?", "--session", instanceIds[0], "--json"],
    codexSessions[0],
  );
  const waitResponse = await waiting;
  await assertStatus(waitResponse, 200, "guest-wait");
  const waited = await waitResponse.json();
  assert.deepEqual(
    waited.items.map((message) => [message.sequence, message.content]),
    [[6, "you there?"]],
  );

  const detailResponse = await fetch(`${apiBaseUrl}/api/v1/rooms/${roomId}`, {
    headers: { authorization: `Bearer ${joined.member_token}` },
  });
  await assertStatus(detailResponse, 200, "guest-room-detail");
  const detail = await detailResponse.json();
  assert.deepEqual(
    detail.memberships.map((member) => member.kind).sort(),
    ["guest", "instance", "instance", "instance", "instance"],
  );

  const storedGuest = await database.query(
    "SELECT token_digest, last_seen_at FROM sharednet.room_guest WHERE id = $1",
    [joined.membership.member_id],
  );
  assert.equal(storedGuest.rowCount, 1);
  assert.notEqual(storedGuest.rows[0].token_digest, joined.member_token, "raw member tokens are never stored");
  const storedInvite = await database.query(
    "SELECT uses, token_digest FROM sharednet.room_invite WHERE id = $1",
    [invite.id],
  );
  assert.equal(storedInvite.rows[0].uses, 1);
  assert.notEqual(storedInvite.rows[0].token_digest, inviteToken);
  const storedGuestMessage = await database.query(
    "SELECT sender_instance_id, sender_guest_id FROM sharednet.message WHERE id = $1",
    [guestMessage.id],
  );
  assert.deepEqual(storedGuestMessage.rows[0], {
    sender_instance_id: null,
    sender_guest_id: joined.membership.member_id,
  });
  await invitePool.end();

  const counts = await database.query(`
    SELECT
      (SELECT count(*)::int FROM sharednet.principal WHERE id = $1) AS principals,
      (SELECT count(*)::int FROM sharednet.agent WHERE principal_id = $1) AS agents,
      (SELECT count(*)::int FROM sharednet.instance WHERE principal_id = $1) AS instances,
      (SELECT count(*)::int FROM sharednet.room WHERE id = $2) AS rooms,
      (SELECT count(*)::int FROM sharednet.message WHERE room_id = $2) AS messages
  `, [starts[0].instance.principal_id, roomId]);
  assert.deepEqual(counts.rows[0], {
    principals: 1,
    agents: 0, // there is no default Agent; a fresh Instance is untagged
    
    instances: 4,
    rooms: 1,
    messages: 6, // four Instances, one guest, one host reply during the guest's wait
  });

  const deleteKeyResponse = await authRequest(
    "/api-key/delete",
    { keyId: keyPayload.id },
    sessionCookie,
  );
  await assertStatus(deleteKeyResponse, 200, "delete-api-key");
  assert.deepEqual(await deleteKeyResponse.json(), { success: true });

  const deletedKey = await database.query(
    'SELECT id FROM sharednet_auth.apikey WHERE id = $1',
    [keyPayload.id],
  );
  assert.equal(deletedKey.rowCount, 0, "Better Auth must be able to delete an issued key");
  const issuerSnapshots = await database.query(
    'SELECT count(*)::int AS count FROM sharednet.instance WHERE principal_id = $1 AND issued_by_key_id = $2',
    [starts[0].instance.principal_id, keyPayload.id],
  );
  assert.equal(
    issuerSnapshots.rows[0].count,
    4,
    "Instance audit provenance must survive API-key deletion",
  );

  const storedSession = JSON.parse(
    await readFile(
      join(sandbox, "state", "sharednet", "sessions", `${instanceIds[0]}.json`),
      "utf8",
    ),
  );
  const revokedDescendantResponse = await fetch(
    `${apiBaseUrl}/api/v1/instances/current`,
    { headers: { authorization: `Bearer ${storedSession.instance_token}` } },
  );
  assert.equal(
    revokedDescendantResponse.status,
    401,
    "deleting an Account API key must invalidate its descendant Instances",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        agent_id: starts[0].instance.agent_id,
        instance_ids: instanceIds,
        messages_seen_after_restart: views.map((view) => view.items.length),
        principal_id: starts[0].instance.principal_id,
        room_id: roomId,
        status: "passed",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (server) await stopServer(server);
  await database.end();
  const { closeDatabase } = await import("../packages/db/src/client.ts");
  await closeDatabase();
  await rm(sandbox, { force: true, recursive: true });
}
