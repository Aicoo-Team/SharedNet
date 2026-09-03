// @vitest-environment node

import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSharedNetDevServer } from "../../server/src/dev-server.ts";
import { MemorySharedNetRepository } from "../../server/src/memory-repository.ts";
import { runCli } from "./cli.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

describe("four local Codex sessions in one chatroom", () => {
  it("registers four Instances of one default Agent and exchanges ordered messages", async () => {
    const apiKey = `snk_${"a".repeat(43)}`;
    const store = new MemorySharedNetRepository({ devApiKey: apiKey });
    const server = createSharedNetDevServer(store);
    servers.push(server);
    const port = await listen(server);
    const root = await mkdtemp(join(tmpdir(), "sharednet-four-codex-"));
    roots.push(root);
    const baseEnvironment = {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      SHAREDNET_BASE_URL: `http://127.0.0.1:${port}`,
      SHAREDNET_API_KEY: apiKey,
      CODEX_THREAD_ID: "one-shared-lineage-that-must-not-be-used",
      PWD: "/workspace/path-that-must-not-be-uploaded",
    };
    const uploadedBodies: string[] = [];
    const tracedFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body === "string") uploadedBodies.push(init.body);
      return fetch(input, init);
    };

    async function command(argv: string[], extraEnv: Record<string, string> = {}) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(argv, {
        env: { ...baseEnvironment, ...extraEnv },
        fetch: tracedFetch,
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      });
      expect(stderr).toEqual([]);
      expect(exitCode).toBe(0);
      return JSON.parse(stdout.join(""));
    }

    const started = await Promise.all(
      ["codex-a", "codex-b", "codex-c", "codex-d"].map((anchor) =>
        command(["session", "start", "--json"], { CODEX_SESSION_ID: anchor }),
      ),
    );
    const instanceIds = started.map((payload) => payload.session_id as string);

    expect(new Set(instanceIds)).toHaveLength(4);
    expect(new Set(started.map((payload) => payload.instance.agent_id))).toHaveLength(1);
    expect(
      await readdir(join(root, "state", "sharednet", "sessions")),
    ).toHaveLength(4);

    const resumed = await command(["session", "start", "--json"], {
      CODEX_SESSION_ID: "codex-a",
    });
    expect(resumed.session_id).toBe(instanceIds[0]);

    const roomResult = await command([
      "--session",
      instanceIds[0]!,
      "room",
      "create",
      "--name",
      "four-codex-room",
      "--json",
    ]);
    const roomId = roomResult.room.id as string;

    await Promise.all(
      instanceIds.slice(1).map((instanceId) =>
        command(["room", "join", roomId, "--session", instanceId, "--json"]),
      ),
    );
    await Promise.all(
      instanceIds.map((instanceId, index) =>
        command([
          "room",
          "post",
          roomId,
          "--content",
          `message-${index + 1}`,
          "--session",
          instanceId,
          "--json",
        ]),
      ),
    );

    const messages = await command(
      ["room", "messages", roomId, "--json"],
      { SHAREDNET_SESSION: instanceIds[3]! },
    );
    expect(messages.items).toHaveLength(4);
    expect(messages.items.map((message: { sequence: number }) => message.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(new Set(messages.items.map((message: { sender_instance_id: string }) =>
      message.sender_instance_id,
    ))).toEqual(new Set(instanceIds));

    const uploaded = uploadedBodies.join("\n");
    for (const localOnlyValue of [
      "codex-a",
      "codex-b",
      "codex-c",
      "codex-d",
      "one-shared-lineage-that-must-not-be-used",
      "/workspace/path-that-must-not-be-uploaded",
      apiKey,
    ]) {
      expect(uploaded).not.toContain(localOnlyValue);
    }
  });
});
