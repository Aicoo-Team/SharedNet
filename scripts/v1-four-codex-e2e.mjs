import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const sandbox = await mkdtemp(join(tmpdir(), "sharednet-v1-e2e-"));
const apiKey = `snk_${randomBytes(32).toString("base64url")}`;
const server = spawn(process.execPath, ["packages/server/src/dev-server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    PORT: "0",
    SHAREDNET_DEV_API_KEY: apiKey,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});

function waitForServer() {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`SharedNet V1 server did not start:\n${serverOutput}`));
    }, 15_000);

    const inspect = () => {
      const match = serverOutput.match(/sharednet-v1 listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolveReady(match[1]);
    };

    server.stdout.on("data", inspect);
    server.stderr.on("data", inspect);
    server.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`SharedNet V1 server exited ${code}:\n${serverOutput}`));
    });
  });
}

function runCli(baseUrl, args, sessionName) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["packages/cli/src/main.ts", ...args], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_SESSION_ID: sessionName,
        CODEX_THREAD_ID: "shared-parent-thread",
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
      assert.equal(/sni_[A-Za-z0-9_-]{43}/.test(combined), false, "Instance token leaked to CLI output");
      if (code !== 0) {
        rejectRun(new Error(`sharednet ${args.join(" ")} exited ${code}:\n${combined}`));
        return;
      }
      try {
        resolveRun(JSON.parse(stdout));
      } catch (error) {
        rejectRun(new Error(`CLI did not return one JSON value: ${stdout}`, { cause: error }));
      }
    });
  });
}

try {
  const baseUrl = await waitForServer();
  const codexSessions = ["codex-alpha", "codex-beta", "codex-gamma", "codex-delta"];
  const starts = await Promise.all(
    codexSessions.map((name) => runCli(baseUrl, ["session", "start", "--json"], name)),
  );

  const instanceIds = starts.map((value) => value.session_id);
  assert.equal(new Set(instanceIds).size, 4, "four Codex sessions must be four Instances");
  assert.equal(new Set(starts.map((value) => value.instance.agent_id)).size, 1);
  assert.equal(new Set(starts.map((value) => value.instance.principal_id)).size, 1);

  const created = await runCli(
    baseUrl,
    ["room", "create", "--name", "Four Codex Room", "--session", instanceIds[0], "--json"],
    codexSessions[0],
  );
  const roomId = created.room.id;

  await Promise.all(
    instanceIds.slice(1).map((instanceId, index) =>
      runCli(
        baseUrl,
        ["room", "join", roomId, "--session", instanceId, "--json"],
        codexSessions[index + 1],
      ),
    ),
  );

  await Promise.all(
    instanceIds.map((instanceId, index) =>
      runCli(
        baseUrl,
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

  const views = await Promise.all(
    instanceIds.map((instanceId, index) =>
      runCli(
        baseUrl,
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

  process.stdout.write(`${JSON.stringify({
    agent_id: starts[0].instance.agent_id,
    instance_ids: instanceIds,
    messages_seen_by_each_instance: views.map((view) => view.items.length),
    principal_id: starts[0].instance.principal_id,
    room_id: roomId,
    status: "passed",
  }, null, 2)}\n`);
} finally {
  server.kill("SIGTERM");
  await rm(sandbox, { force: true, recursive: true });
}
