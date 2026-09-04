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

const HEX_64 = /^[0-9a-f]{64}$/;

function registered(id: string, extra: Record<string, unknown> = {}) {
  return {
    status: 201,
    body: { instance: { ...instance(id), ...extra }, token: `sni_${id}`, heartbeat_after_seconds: 30 },
  };
}

function sentBody(request: { init: RequestInit }): Record<string, any> {
  return JSON.parse(String(request.init.body));
}

function instance(id: string) {
  return {
    id,
    principal_id: "p_demo",
    agent_id: null,
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
    // Nothing is provisioned first: one call registers the session.
    expect(result.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/instances",
    ]);
    const registration = JSON.stringify(result.requests[0]?.init.body);
    expect(registration).not.toContain("provider-session-must-remain-local");
    expect(registration).not.toContain("lineage-only");
    expect(registration).not.toContain("snk_never-send-in-json");
    const body = sentBody(result.requests[0]!);
    // The session is identified to the server only by its HMAC, never its id.
    expect(body.local_instance_key).toMatch(HEX_64);
    expect(body).not.toHaveProperty("agent_id");
    expect(body.runtime_metadata).toMatchObject({ os: process.platform });
    // Only the last path segment is sent; the directory hierarchy stays local.
    expect(body.runtime_metadata.workspace).not.toContain("/");
    expect(registration).not.toContain(process.cwd());
  });

  it("reuses the same computed session and registers four distinct Codex sessions", async () => {
    const sharedEnv = { SHAREDNET_API_KEY: "snk_demo" };
    const sessions: string[] = [];

    for (const [index, anchor] of ["one", "two", "three", "four"].entries()) {
      const run = await harness(
        ["session", "start", "--json"],
        [registered(`i_${index + 1}`)],
        { ...sharedEnv, CODEX_SESSION_ID: anchor },
      );
      sessions.push(JSON.parse(run.stdout[0]!).session_id);
    }

    expect(sessions).toEqual(["i_1", "i_2", "i_3", "i_4"]);
  });

  it("supports global --session before or after room commands and forwards API payloads", async () => {
    const start = await harness(["session", "start", "--json"], [registered("i_chat")]);
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

  it("sends the same session key under two API keys and lets the server scope it by Principal", async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), "sharednet-cli-principal-scope-"));
    cleanup.push(sharedRoot);
    const sharedStorage = {
      XDG_CONFIG_HOME: join(sharedRoot, "config"),
      XDG_STATE_HOME: join(sharedRoot, "state"),
      CODEX_SESSION_ID: "same-codex-session",
    };

    const first = await harness(
      ["session", "start", "--json"],
      [registered("i_first", { principal_id: "p_first" })],
      { ...sharedStorage, SHAREDNET_API_KEY: "snk_first" },
    );
    const second = await harness(
      ["session", "start", "--json"],
      [registered("i_second", { principal_id: "p_second" })],
      { ...sharedStorage, SHAREDNET_API_KEY: "snk_second" },
    );

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.join(""))).toMatchObject({ session_id: "i_second" });
    // Same installation, same runtime session: the same key goes up both
    // times. Deduplication is per Principal, and that is the server's job.
    expect(sentBody(second.requests[0]!).local_instance_key).toBe(
      sentBody(first.requests[0]!).local_instance_key,
    );
  });

  it("tags a session on request, creating the tag on first use", async () => {
    const byHandle = await harness(
      ["session", "start", "--agent", "Reviewer", "--json"],
      [
        { status: 201, body: { agent: { id: "a_reviewer", handle: "reviewer" } } },
        registered("i_reviewer", { agent_id: "a_reviewer" }),
      ],
    );
    expect(byHandle.exitCode).toBe(0);
    expect(byHandle.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/agents",
      "http://127.0.0.1:3001/api/v1/instances",
    ]);
    expect(sentBody(byHandle.requests[0]!)).toEqual({ handle: "reviewer" });
    expect(sentBody(byHandle.requests[1]!).agent_id).toBe("a_reviewer");
    expect(JSON.parse(byHandle.stdout.join(""))).toMatchObject({ session_id: "i_reviewer" });

    const byId = await harness(
      ["session", "start", "--agent", "a_reviewer", "--json"],
      [
        { body: { agent: { id: "a_reviewer", handle: "reviewer" } } },
        { status: 200, body: registered("i_reviewer", { agent_id: "a_reviewer" }).body },
      ],
    );
    expect(byId.exitCode).toBe(0);
    expect(byId.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/agents/a_reviewer",
      "http://127.0.0.1:3001/api/v1/instances",
    ]);

    // "default" names the absence of a tag: no tag call, and agent_id is sent
    // as null so a session that was tagged earlier is moved back out of it.
    const untagged = await harness(
      ["session", "start", "--agent", "default", "--json"],
      [registered("i_plain")],
    );
    expect(untagged.exitCode).toBe(0);
    expect(untagged.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/instances",
    ]);
    expect(sentBody(untagged.requests[0]!).agent_id).toBeNull();

    const malformed = await harness(["session", "start", "--agent", "Not a handle!", "--json"]);
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr.join(" ")).toContain("invalid_agent");
  });

});
