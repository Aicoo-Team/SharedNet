// @vitest-environment node

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.ts";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

async function harness(
  argv: string[],
  responses: Array<{ status?: number; body?: unknown }> = [],
  environment: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sharednet-cli-run-"));
  cleanup.push(root);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.body === undefined ? undefined : { "content-type": "application/json" },
    });
  });
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    SHAREDNET_BASE_URL: "http://127.0.0.1:3001",
    SHAREDNET_API_KEY: "snk_never-send-in-json",
    CODEX_SESSION_ID: "provider-session-must-remain-local",
    CODEX_THREAD_ID: "lineage-only",
    ...environment,
  };

  const exitCode = await runCli(argv, {
    env,
    fetch,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  return { exitCode, stdout, stderr, requests };
}

const defaultAgent = {
  id: "a_default",
  principal_id: "p_demo",
  handle: "default",
};

function instance(id: string) {
  return {
    id,
    principal_id: "p_demo",
    agent_id: "a_default",
    runtime_kind: "codex",
    cli_version: "0.1.0",
    status: "online",
    started_at: "2026-09-04T00:00:00.000Z",
    lease_expires_at: "2099-09-04T00:01:30.000Z",
    token_expires_at: "2099-09-05T00:00:00.000Z",
    ended_at: null,
    revoked_at: null,
  };
}

describe("sharednet CLI vertical slice", () => {
  it("starts and safely persists a computed Instance", async () => {
    const result = await harness(
      ["session", "start", "--json"],
      [
        { body: { agent: defaultAgent } },
        {
          status: 201,
          body: {
            instance: instance("i_one"),
            token: "sni_do-not-print",
            heartbeat_after_seconds: 30,
          },
        },
      ],
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.join(""))).toEqual({
      instance: instance("i_one"),
      session_id: "i_one",
      heartbeat_after_seconds: 30,
    });
    expect(result.stderr).toEqual([]);
    expect(result.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/agents/default",
      "http://127.0.0.1:3001/api/v1/agents/a_default/instances",
    ]);
    const registration = JSON.stringify(result.requests[1]?.init.body);
    expect(registration).not.toContain("provider-session-must-remain-local");
    expect(registration).not.toContain("lineage-only");
    expect(registration).not.toContain("snk_never-send-in-json");
  });

  it("reuses the same computed session and registers four distinct Codex sessions", async () => {
    const sharedEnv = { SHAREDNET_API_KEY: "snk_demo" };
    const sessions: string[] = [];

    for (const [index, anchor] of ["one", "two", "three", "four"].entries()) {
      const run = await harness(
        ["session", "start", "--json"],
        [
          { body: { agent: defaultAgent } },
          {
            status: 201,
            body: {
              instance: instance(`i_${index + 1}`),
              token: `sni_${index + 1}`,
              heartbeat_after_seconds: 30,
            },
          },
        ],
        { ...sharedEnv, CODEX_SESSION_ID: anchor },
      );
      sessions.push(JSON.parse(run.stdout[0]!).session_id);
    }

    expect(sessions).toEqual(["i_1", "i_2", "i_3", "i_4"]);
  });

  it("supports global --session before or after room commands and forwards API payloads", async () => {
    const start = await harness(
      ["session", "start", "--json"],
      [
        { body: { agent: defaultAgent } },
        {
          status: 201,
          body: {
            instance: instance("i_chat"),
            token: "sni_room-token",
            heartbeat_after_seconds: 30,
          },
        },
      ],
    );
    expect(start.exitCode).toBe(0);

    // A single harness cannot share a generated temp state, so exercise command parsing
    // with an explicit state root in the dedicated integration test below.
    const missing = await harness([
      "--session",
      "i_chat",
      "room",
      "post",
      "rom_team",
      "--content",
      "hello",
      "--json",
    ]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr.join(" ")).toContain("session_not_found");

    const after = await harness([
      "room",
      "messages",
      "rom_team",
      "--session",
      "i_chat",
      "--json",
    ]);
    expect(after.exitCode).toBe(2);
    expect(after.stderr.join(" ")).toContain("session_not_found");
  });

  it("rejects API keys in argv and unsafe non-local HTTP base URLs", async () => {
    const argvSecret = await harness(["session", "start", "--api-key", "snk_bad", "--json"]);
    expect(argvSecret.exitCode).toBe(2);
    expect(argvSecret.stdout).toEqual([]);
    expect(argvSecret.stderr.join(" ")).not.toContain("snk_bad");

    const unsafeUrl = await harness(["session", "start", "--json"], [], {
      SHAREDNET_BASE_URL: "http://sharednet.example.test",
    });
    expect(unsafeUrl.exitCode).toBe(2);
    expect(unsafeUrl.stderr.join(" ")).toContain("invalid_base_url");
  });

  it("maps safe API errors to the documented exit codes", async () => {
    const auth = await harness(
      ["session", "start", "--json"],
      [{ status: 401, body: { error: { code: "invalid_credentials", message: "No." } } }],
    );
    expect(auth.exitCode).toBe(3);
    expect(auth.stdout).toEqual([]);
    expect(auth.stderr.join(" ")).toContain("invalid_credentials");

    const domain = await harness(
      ["session", "start", "--json"],
      [{ status: 409, body: { error: { code: "conflict", message: "Conflict." } } }],
    );
    expect(domain.exitCode).toBe(4);
  });

  it("does not resume a computed Instance after the API key changes Principal", async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), "sharednet-cli-principal-scope-"));
    cleanup.push(sharedRoot);
    const sharedStorage = {
      XDG_CONFIG_HOME: join(sharedRoot, "config"),
      XDG_STATE_HOME: join(sharedRoot, "state"),
      CODEX_SESSION_ID: "same-codex-session",
    };
    const firstAgent = { ...defaultAgent, id: "a_first", principal_id: "p_first" };
    const secondAgent = { ...defaultAgent, id: "a_second", principal_id: "p_second" };

    const first = await harness(
      ["session", "start", "--json"],
      [
        { body: { agent: firstAgent } },
        {
          status: 201,
          body: {
            instance: {
              ...instance("i_first"),
              principal_id: "p_first",
              agent_id: "a_first",
            },
            token: "sni_first",
            heartbeat_after_seconds: 30,
          },
        },
      ],
      { ...sharedStorage, SHAREDNET_API_KEY: "snk_first" },
    );
    expect(first.exitCode).toBe(0);

    const second = await harness(
      ["session", "start", "--json"],
      [
        { body: { agent: secondAgent } },
        {
          status: 201,
          body: {
            instance: {
              ...instance("i_second"),
              principal_id: "p_second",
              agent_id: "a_second",
            },
            token: "sni_second",
            heartbeat_after_seconds: 30,
          },
        },
      ],
      { ...sharedStorage, SHAREDNET_API_KEY: "snk_second" },
    );

    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.join(""))).toMatchObject({ session_id: "i_second" });
    expect(second.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/agents/default",
      "http://127.0.0.1:3001/api/v1/agents/a_second/instances",
    ]);
  });

  it("does not resume the same computed runtime under a different explicit Agent", async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), "sharednet-cli-agent-scope-"));
    cleanup.push(sharedRoot);
    const sharedStorage = {
      XDG_CONFIG_HOME: join(sharedRoot, "config"),
      XDG_STATE_HOME: join(sharedRoot, "state"),
      CODEX_SESSION_ID: "same-codex-session",
      SHAREDNET_API_KEY: "snk_one-principal",
    };
    const first = await harness(
      ["session", "start", "--json"],
      [
        { body: { agent: defaultAgent } },
        {
          status: 201,
          body: {
            instance: instance("i_default"),
            token: "sni_default",
            heartbeat_after_seconds: 30,
          },
        },
      ],
      sharedStorage,
    );
    expect(first.exitCode).toBe(0);

    const reviewerAgent = {
      ...defaultAgent,
      id: "a_reviewer",
      handle: "reviewer",
      is_default: false,
    };
    const switched = await harness(
      ["session", "start", "--agent", "a_reviewer", "--json"],
      [
        { body: { agent: reviewerAgent } },
        {
          status: 201,
          body: {
            instance: { ...instance("i_reviewer"), agent_id: "a_reviewer" },
            token: "sni_reviewer",
            heartbeat_after_seconds: 30,
          },
        },
      ],
      sharedStorage,
    );

    expect(switched.exitCode).toBe(0);
    expect(JSON.parse(switched.stdout.join(""))).toMatchObject({
      session_id: "i_reviewer",
    });
    expect(switched.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/agents/a_reviewer",
      "http://127.0.0.1:3001/api/v1/agents/a_reviewer/instances",
    ]);
  });
});
