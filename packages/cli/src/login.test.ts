// @vitest-environment node

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRequest } from "../../server/src/handler.ts";
import { MemorySharedNetRepository } from "../../server/src/memory-repository.ts";
import { runCli } from "./cli.ts";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "sharednet-login-"));
  cleanup.push(root);
  return {
    root,
    project: join(root, "project"),
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      SHAREDNET_BASE_URL: "http://127.0.0.1:3001",
      CODEX_SESSION_ID: "session-stays-local",
    } as Record<string, string>,
  };
}

const API_KEY = `snk_${"k".repeat(43)}`;

describe("sharednet login", () => {
  it("names only the seats this machine holds for this origin; a seat of another SharedNet is never sent here", async () => {
    const space = await workspace();
    const { getStoragePaths, writeRoomCredential } = await import("./storage.ts");
    const paths = getStoragePaths(space.env);
    const seat = (baseUrl: string, roomId: string, memberId: string, token: string) =>
      writeRoomCredential(paths, { schema_version: 1, base_url: baseUrl, room_id: roomId, member_id: memberId, name: "claude-code", member_token: token, joined_at: "2026-09-08T00:00:00.000Z" });
    const here = `sni_${"h".repeat(43)}`;
    const elsewhere = `sni_${"e".repeat(43)}`;
    await seat("http://127.0.0.1:3001", "rom_HereAbcdef", "i_HereAbcdef", here);
    await seat("https://other.example", "rom_ThereAbcde", "i_ThereAbcde", elsewhere);

    const requests: Array<{ url: string; body: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(input), body: String(init.body ?? "") });
      // The first answer starts the login; the second approves it.
      const body =
        requests.length === 1
          ? { login: { id: "cli_AbCdEfGhIj", expires_at: "2099-01-01T00:00:00.000Z", bind_instance_ids: ["i_HereAbcdef"] }, user_code: "ABCD-EFGH", poll_token: `clp_${"p".repeat(43)}`, verify_url: "http://127.0.0.1:3001/cli/authorize?code=ABCD-EFGH", interval_seconds: 3 }
          : { state: "approved", login: { id: "cli_AbCdEfGhIj", bind_instance_ids: ["i_HereAbcdef"] }, api_key: API_KEY, api_key_id: "key_AbCdEfGhIj", principal: { id: "p_AbCdEfGhIj", display_name: null, created_at: "2026-09-06T00:00:00.000Z", invited_by_principal_id: null } };
      return new Response(JSON.stringify(body), { status: requests.length === 1 ? 201 : 200, headers: { "content-type": "application/json" } });
    });
    const exitCode = await runCli(["login", "--no-browser", "--json"], {
      cwd: space.project,
      env: space.env,
      fetch,
      stdout: () => {},
      stderr: () => {},
      sleep: async () => {},
    });
    expect(exitCode).toBe(0);
    const started = JSON.parse(requests[0]!.body);
    expect(started.seats).toEqual([here]);
    expect(JSON.stringify(requests)).not.toContain(elsewhere);
  });

  it("shows the code and URL, opens the browser, polls until approved, and keeps the key in the credential file", async () => {
    const space = await workspace();
    const responses = [
      {
        status: 201,
        body: {
          login: { id: "cli_AbCdEfGhIj", expires_at: "2099-01-01T00:00:00.000Z", bind_instance_ids: [] },
          user_code: "ABCD-EFGH",
          poll_token: `clp_${"p".repeat(43)}`,
          verify_url: "http://127.0.0.1:3001/cli/authorize?code=ABCD-EFGH",
          interval_seconds: 3,
        },
      },
      { status: 200, body: { state: "pending", login: { id: "cli_AbCdEfGhIj" } } },
      {
        status: 200,
        body: {
          state: "approved",
          login: { id: "cli_AbCdEfGhIj", bind_instance_ids: [] },
          api_key: API_KEY,
          api_key_id: "key_AbCdEfGhIj",
          principal: { id: "p_AbCdEfGhIj", display_name: "Xisen", created_at: "2026-09-06T00:00:00.000Z", invited_by_principal_id: null },
        },
      },
    ];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(input), init });
      const next = responses.shift();
      if (!next) throw new Error("Unexpected fetch");
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    });
    const opened: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sleeps: number[] = [];

    const exitCode = await runCli(["login", "--label", "laptop", "--json"], {
      env: space.env,
      fetch,
      cwd: space.project,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      openBrowser: async (url) => {
        opened.push(url);
        return true;
      },
    });

    expect(exitCode).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/cli/logins",
      "http://127.0.0.1:3001/api/v1/cli/logins/cli_AbCdEfGhIj/poll",
      "http://127.0.0.1:3001/api/v1/cli/logins/cli_AbCdEfGhIj/poll",
    ]);
    // Starting a login sends no credential; polling sends the poll token.
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ label: "laptop" });
    expect((requests[1]!.init.headers as Record<string, string>).authorization).toBe(`Bearer clp_${"p".repeat(43)}`);
    expect(opened).toEqual(["http://127.0.0.1:3001/cli/authorize?code=ABCD-EFGH"]);
    expect(sleeps).toEqual([3000]);
    expect(stderr.join("")).toContain("ABCD-EFGH");
    expect(stderr.join("")).toContain("http://127.0.0.1:3001/cli/authorize?code=ABCD-EFGH");

    const output = JSON.parse(stdout.join(""));
    expect(output).toEqual({
      principal_id: "p_AbCdEfGhIj",
      api_key_id: "key_AbCdEfGhIj",
      bound_instance_ids: [],
      credentials_file: join(space.env.XDG_CONFIG_HOME!, "sharednet", "credentials.json"),
    });
    expect(stdout.join("")).not.toContain("snk_");
    expect(stderr.join("")).not.toContain("snk_");

    const credentialsFile = join(space.env.XDG_CONFIG_HOME!, "sharednet", "credentials.json");
    expect((await stat(credentialsFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialsFile, "utf8"))).toMatchObject({
      base_url: "http://127.0.0.1:3001",
      principal_id: "p_AbCdEfGhIj",
      api_key_id: "key_AbCdEfGhIj",
      api_key: API_KEY,
      expires_at: null,
    });
  });

  it("logs in against the real handler, binding a seat this machine holds, and the key then registers Instances", async () => {
    const DEV_KEY = `snk_${"a".repeat(43)}`;
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const fetch: typeof globalThis.fetch = (input, init) => handleRequest(new Request(input as string | URL, init), store);
    const api = async (path: string, init: RequestInit) => {
      const response = await fetch(`http://127.0.0.1:3001/api/v1${path}`, init);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const space = await workspace();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(space.project, { recursive: true });
    const cli = async (argv: string[], extraEnv: Record<string, string> = {}) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(argv, {
        env: { ...space.env, ...extraEnv },
        fetch,
        cwd: space.project,
        sleep: async () => undefined,
        openBrowser: async () => true,
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      });
      return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
    };

    // A host opens a Room and invites; this machine joins anonymously and speaks.
    const host = await api("/instances", {
      method: "POST",
      headers: { authorization: `Bearer ${DEV_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3" }),
    });
    const created = await api("/rooms", {
      method: "POST",
      headers: { authorization: `Bearer ${host.body.token}`, "content-type": "application/json", "idempotency-key": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" },
      body: JSON.stringify({ name: "Binding" }),
    });
    const roomId = created.body.room.id as string;
    const { token: invite } = await store.createRoomInvite({ roomId: roomId as `rom_${string}`, principalId: host.body.instance.principal_id });
    const joined = await cli(["join", `ROOM=${roomId} TOKEN=${invite}`, "--name", "claude-code", "--json"]);
    expect(joined.exitCode).toBe(0);
    const seat = JSON.parse(joined.stdout);
    expect(await cli(["say", "hello before binding", "--json"]).then((r) => r.exitCode)).toBe(0);

    // Login: the CLI names the seat; the approve happens as the host's account.
    const started = store.startCliLogin.bind(store);
    let userCode = "";
    store.startCliLogin = async (input) => {
      const result = await started(input);
      userCode = result.user_code;
      // Approve as soon as it is started, so the CLI's first poll succeeds.
      await store.approveCliLogin({ code: userCode, principalId: host.body.instance.principal_id });
      return result;
    };
    const login = await cli(["login", "--no-browser", "--json"]);
    expect(login.stderr).not.toContain("snk_");
    expect(login.exitCode).toBe(0);
    const result = JSON.parse(login.stdout);
    expect(result.principal_id).toBe(host.body.instance.principal_id);
    expect(result.bound_instance_ids).toEqual([seat.member_id]);

    // The seat and what it said now belong to the account.
    const detail = await api(`/rooms/${roomId}`, { headers: { authorization: `Bearer ${host.body.token}` } });
    const bound = detail.body.memberships.find((m: any) => m.member_id === seat.member_id);
    expect(bound.principal_id).toBe(host.body.instance.principal_id);

    // The stored key works for the power path without SHAREDNET_API_KEY in the environment.
    const session = await cli(["session", "start", "--json"]);
    expect(session.exitCode).toBe(0);
    expect(JSON.parse(session.stdout).instance.principal_id).toBe(host.body.instance.principal_id);

    // And from now on, a join with an invite is as the account: door A, same invite.
    const second = await api("/rooms", {
      method: "POST",
      headers: { authorization: `Bearer ${host.body.token}`, "content-type": "application/json", "idempotency-key": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e" },
      body: JSON.stringify({ name: "Second" }),
    });
    const { token: invite2 } = await store.createRoomInvite({ roomId: second.body.room.id, principalId: host.body.instance.principal_id });
    const { mkdir: mk } = await import("node:fs/promises");
    const secondProject = join(space.root, "second");
    await mk(secondProject, { recursive: true });
    const stdout: string[] = [];
    const exit = await runCli(["join", `ROOM=${second.body.room.id} TOKEN=${invite2}`, "--json"], {
      env: space.env,
      fetch,
      cwd: secondProject,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });
    expect(exit).toBe(0);
    const asAccount = JSON.parse(stdout.join(""));
    expect(asAccount.as).toBe("account");
    expect(asAccount.principal_id).toBe(host.body.instance.principal_id);
    const members = await api(`/rooms/${second.body.room.id}`, { headers: { authorization: `Bearer ${host.body.token}` } });
    const mine = members.body.memberships.find((m: any) => m.member_id === asAccount.member_id);
    expect(mine).toMatchObject({ kind: "instance", admitted_by: "invite", principal_id: host.body.instance.principal_id });
  });
});
