// @vitest-environment node

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRequest } from "../../server/src/handler.ts";
import { MemorySharedNetRepository } from "../../server/src/memory-repository.ts";
import { runCli } from "./cli.ts";
import type { CommandRunner } from "./guest.ts";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

const INVITE_TOKEN = `rit_${"I".repeat(43)}`;
const MEMBER_TOKEN = `sni_${"M".repeat(43)}`;
const ROOM_ID = "rom_AbCdEfGhIj";
const MEMBER_ID = "i_KlMnOpQrSt";

const PASTED_INVITE = [
  `Join SharedNet Room ${ROOM_ID} ("Launch review") as a guest.`,
  `ROOM=${ROOM_ID}`,
  `TOKEN=${INVITE_TOKEN}`,
  "BASE=https://sharednet.ai",
  "",
  '1. Join, and read what was said so far. Keep member_token from the response and note the highest sequence in history.items:',
  `   curl -s -X POST "$BASE/api/v1/rooms/$ROOM/join" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"<your name, e.g. claude-code>"}'`,
].join("\n");

function message(sequence: number, content: string, name: string | null = "host") {
  return {
    id: `msg_${String(sequence).padStart(10, "0")}`,
    room_id: ROOM_ID,
    sequence,
    type: "message",
    content,
    sender: { member_id: "i_HostHostHo", kind: "instance", name },
    created_at: "2026-09-05T10:00:00.000Z",
  };
}

function joined(items: ReturnType<typeof message>[] = []) {
  return {
    status: 200,
    body: {
      room: { id: ROOM_ID, name: "Launch review", state: "open" },
      membership: { member_id: MEMBER_ID, kind: "guest", name: "claude-code", state: "active" },
      member_token: MEMBER_TOKEN,
      history: { items, next_cursor: items.length ? String(items.at(-1)!.sequence) : null, has_more: false },
    },
  };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "sharednet-guest-"));
  cleanup.push(root);
  return {
    root,
    project: join(root, "project"),
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      CLAUDE_SESSION_ID: "claude-session-stays-local",
    } as Record<string, string>,
  };
}

async function run(
  argv: string[],
  space: Awaited<ReturnType<typeof workspace>>,
  responses: Array<{ status?: number; body?: unknown }>,
  environment: Record<string, string> = {},
  overrides: { exec?: CommandRunner; now?: () => Date } = {},
) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(space.project, { recursive: true });
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
  const exitCode = await runCli(argv, {
    env: { ...space.env, ...environment },
    fetch,
    cwd: space.project,
    sleep: async () => undefined,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    ...overrides,
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), requests };
}

function own(sequence: number, content: string) {
  return { ...message(sequence, content, "claude-code"), sender: { member_id: MEMBER_ID, kind: "guest", name: "claude-code" } };
}

function page(items: ReturnType<typeof message>[]) {
  return { status: 200, body: { items, next_cursor: null, has_more: false } };
}

/** A command runner that records what it was given and answers with a fixed result. */
function recorder(result: { exitCode: number; stdout: string; stderr?: string }) {
  const calls: Array<{ command: string; input: unknown; env: Record<string, string> }> = [];
  const exec: CommandRunner = async (command, input, env) => {
    calls.push({ command, input: JSON.parse(input), env });
    return { stderr: "", ...result };
  };
  return { calls, exec };
}

function header(request: { init: RequestInit }, name: string): string | undefined {
  return (request.init.headers as Record<string, string>)[name];
}

describe("sharednet join", () => {
  it("joins from the pasted Web invite, keeps the tokens out of the project and out of stdout", async () => {
    const space = await workspace();
    const result = await run(["join", PASTED_INVITE], space, [
      joined([message(1, "Welcome"), message(2, "Agenda is in the doc")]),
    ]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.requests).toHaveLength(1);
    const [request] = result.requests;
    // The invite's BASE says where the Room lives; the invite token is the credential.
    expect(request!.url).toBe(`https://sharednet.ai/api/v1/rooms/${ROOM_ID}/join`);
    expect(request!.init.method).toBe("POST");
    expect(header(request!, "authorization")).toBe(`Bearer ${INVITE_TOKEN}`);
    // The driver that is running names the seat and is reported as detected; its session id stays local.
    expect(JSON.parse(String(request!.init.body))).toEqual({
      name: "claude-code",
      runtime: { kind: "claude-code", version: null, entrypoint: null, source: "detected" },
    });
    expect(String(request!.init.body)).not.toContain("claude-session-stays-local");

    const output = JSON.parse(result.stdout);
    expect(output).toEqual({
      room: { id: ROOM_ID, name: "Launch review", state: "open" },
      member_id: MEMBER_ID,
      principal_id: null,
      as: "anonymous",
      name: "claude-code",
      last_sequence: 2,
      history: expect.objectContaining({ items: expect.any(Array) }),
    });
    expect(result.stdout).not.toContain("sni_");
    expect(result.stdout).not.toContain("rit_");

    // The member token lives owner-only under the config directory…
    const credentialFile = join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", ROOM_ID, `${MEMBER_ID}.json`);
    expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialFile, "utf8"))).toMatchObject({
      room_id: ROOM_ID,
      member_id: MEMBER_ID,
      member_token: MEMBER_TOKEN,
    });
    // …and the project holds only the cursor, in a directory that ignores itself.
    const state = await readFile(join(space.project, ".sharednet", "room.json"), "utf8");
    expect(JSON.parse(state)).toEqual({
      schema_version: 1,
      base_url: "https://sharednet.ai",
      room_id: ROOM_ID,
      member_id: MEMBER_ID,
      last_sequence: 2,
    });
    expect(state).not.toContain("sni_");
    expect(await readFile(join(space.project, ".sharednet", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("joins a bare Room id with the token from the environment, and takes --name", async () => {
    const space = await workspace();
    const result = await run(
      ["join", ROOM_ID, "--name", "reviewer", "--json"],
      space,
      [joined()],
      { SHAREDNET_INVITE_TOKEN: INVITE_TOKEN, SHAREDNET_BASE_URL: "http://127.0.0.1:3001" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.requests[0]!.url).toBe(`http://127.0.0.1:3001/api/v1/rooms/${ROOM_ID}/join`);
    expect(JSON.parse(String(result.requests[0]!.init.body))).toEqual({
      name: "reviewer",
      runtime: { kind: "claude-code", version: null, entrypoint: null, source: "detected" },
    });
    expect(JSON.parse(result.stdout).last_sequence).toBe(0);
  });

  it("reports no driver when none is recognised, and names the seat 'agent'", async () => {
    const space = await workspace();
    const result = await run(
      ["join", PASTED_INVITE, "--json"],
      { ...space, env: { HOME: space.env.HOME!, XDG_CONFIG_HOME: space.env.XDG_CONFIG_HOME!, XDG_STATE_HOME: space.env.XDG_STATE_HOME! } },
      [joined()],
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(String(result.requests[0]!.init.body));
    expect(body).toEqual({ name: "agent" });
  });

  it("joins as the account when a credential is present: registers an Instance, joins with the invite, reads history", async () => {
    const space = await workspace();
    const instance = {
      id: "i_AccountSeat1",
      principal_id: "p_AcCoUnT0001",
      agent_id: null,
      runtime_kind: "claude-code",
      cli_version: "0.1.0",
      status: "online",
      display_name: null,
      started_at: "2026-09-06T00:00:00.000Z",
      last_seen_at: "2026-09-06T00:00:00.000Z",
      lease_expires_at: "2099-09-06T00:01:30.000Z",
      token_expires_at: "2099-09-07T00:00:00.000Z",
      ended_at: null,
      revoked_at: null,
    };
    const result = await run(
      ["join", PASTED_INVITE, "--json"],
      space,
      [
        { status: 201, body: { instance, token: `sni_${"A".repeat(43)}`, heartbeat_after_seconds: 30 } },
        {
          status: 200,
          body: {
            room: { id: ROOM_ID, name: "Launch review", state: "open" },
            membership: { member_id: "i_AccountSeat1", principal_id: "p_AcCoUnT0001", kind: "instance", admitted_by: "invite", name: null, state: "active" },
          },
        },
        { status: 200, body: { items: [message(1, "Welcome")], next_cursor: "1", has_more: false } },
      ],
      { SHAREDNET_API_KEY: `snk_${"K".repeat(43)}` },
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.requests.map((request) => `${request.init.method ?? "GET"} ${request.url}`)).toEqual([
      "POST https://sharednet.ai/api/v1/instances",
      `POST https://sharednet.ai/api/v1/rooms/${ROOM_ID}/join`,
      `GET https://sharednet.ai/api/v1/rooms/${ROOM_ID}/messages?after=0&limit=100`,
    ]);
    expect(header(result.requests[0]!, "authorization")).toBe(`Bearer snk_${"K".repeat(43)}`);
    expect(header(result.requests[1]!, "authorization")).toBe(`Bearer sni_${"A".repeat(43)}`);
    // The invite admits the Instance; the runtime went with the registration, not the join.
    expect(JSON.parse(String(result.requests[1]!.init.body))).toEqual({ invite: INVITE_TOKEN });
    expect(JSON.parse(String(result.requests[0]!.init.body)).runtime_kind).toBe("claude-code");
    expect(header(result.requests[1]!, "idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);

    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ as: "account", member_id: "i_AccountSeat1", principal_id: "p_AcCoUnT0001", last_sequence: 1 });
    expect(result.stdout).not.toContain("sni_");
    expect(result.stdout).not.toContain("snk_");
    const state = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
    expect(state).toMatchObject({ room_id: ROOM_ID, member_id: "i_AccountSeat1", last_sequence: 1 });
    // Both the seat file and the session file exist; say/wait use the session's token.
    await stat(join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", ROOM_ID, "i_AccountSeat1.json"));
    await stat(join(space.env.XDG_STATE_HOME!, "sharednet", "sessions", "i_AccountSeat1.json"));

    const said = await run(["say", "as the account", "--json"], space, [
      { status: 201, body: { message: message(2, "as the account", null) } },
    ], { SHAREDNET_API_KEY: `snk_${"K".repeat(43)}` });
    expect(said.exitCode).toBe(0);
    expect(header(said.requests[0]!, "authorization")).toBe(`Bearer sni_${"A".repeat(43)}`);
  });

  it("refuses to join without an invite token, before any request is sent", async () => {
    const space = await workspace();
    const result = await run(["join", ROOM_ID, "--json"], space, []);

    expect(result.exitCode).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(JSON.parse(result.stderr).error.code).toBe("invite_token_required");
  });

  it("keeps two seats in one Room apart when two Agents share one machine", async () => {
    // Found by the two-Agent demo: Codex and Claude Code on one machine joined
    // the same Room, and the second join used to overwrite the first's file.
    const space = await workspace();
    const first = await run(["join", PASTED_INVITE, "--name", "claude-code"], space, [joined()]);
    expect(first.exitCode).toBe(0);
    const secondProject = join(space.root, "second-project");
    const secondSeat = { ...joined(), body: { ...joined().body, membership: { ...joined().body.membership, member_id: "i_SecondSeat1", name: "codex" }, member_token: `sni_${"S".repeat(43)}` } };
    const second = await run(["join", PASTED_INVITE, "--name", "codex"], { ...space, project: secondProject }, [secondSeat]);
    expect(second.exitCode).toBe(0);

    // Each project still speaks with its own token.
    const firstSay = await run(["say", "from the first seat", "--json"], space, [
      { status: 201, body: { message: message(2, "from the first seat", "claude-code") } },
    ]);
    expect(firstSay.exitCode).toBe(0);
    expect(header(firstSay.requests[0]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    const secondSay = await run(["say", "from the second seat", "--json"], { ...space, project: secondProject }, [
      { status: 201, body: { message: message(3, "from the second seat", "codex") } },
    ]);
    expect(secondSay.exitCode).toBe(0);
    expect(header(secondSay.requests[0]!, "authorization")).toBe(`Bearer sni_${"S".repeat(43)}`);
  });

  it("does not treat a stored API key or --session as a way in", async () => {
    const space = await workspace();
    const result = await run(["join", PASTED_INVITE, "--session", "i_HostHostHo"], space, []);

    expect(result.exitCode).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(result.stderr).toContain("invalid_option");
  });
});

describe("sharednet say and wait", () => {
  async function joinedSpace() {
    const space = await workspace();
    const result = await run(["join", PASTED_INVITE], space, [joined([message(1, "Welcome")])]);
    expect(result.exitCode).toBe(0);
    return space;
  }

  it("says with the stored member token and never moves the cursor", async () => {
    const space = await joinedSpace();
    const result = await run(["say", "Build is green.", "--json"], space, [
      { status: 201, body: { message: { ...message(2, "Build is green.", "claude-code"), sender: { member_id: MEMBER_ID, kind: "guest", name: "claude-code" } } } },
    ]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const [request] = result.requests;
    expect(request!.url).toBe(`https://sharednet.ai/api/v1/rooms/${ROOM_ID}/messages`);
    expect(header(request!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    expect(JSON.parse(String(request!.init.body))).toEqual({ content: "Build is green." });
    expect(JSON.parse(result.stdout).message.sequence).toBe(2);
    // A message of one's own is not "seen": anything said before it still arrives.
    const state = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
    expect(state.last_sequence).toBe(1);
  });

  it("threads a reply with --reply-to and refuses anything that is not a message id", async () => {
    const space = await joinedSpace();
    const result = await run(["say", "Yes, on it.", "--reply-to", "msg_AbCdEfGhIj", "--json"], space, [
      { status: 201, body: { message: { ...message(2, "Yes, on it.", "claude-code"), reply_to_message_id: "msg_AbCdEfGhIj" } } },
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.requests[0]!.init.body))).toEqual({
      content: "Yes, on it.",
      reply_to_message_id: "msg_AbCdEfGhIj",
    });

    const refused = await run(["say", "Yes, on it.", "--reply-to", "2", "--json"], space, []);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.requests).toHaveLength(0);
    expect(refused.stderr).toContain("--reply-to must be a message id");
  });

  it("joins as a private seat when asked, so strangers with the id must ask first", async () => {
    const space = await workspace();
    const result = await run(["join", PASTED_INVITE, "--private", "--json"], space, [joined([message(1, "Welcome")])]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.requests[0]!.init.body))).toMatchObject({ reach: "private" });
  });

  it("seats more Instances by id from the current seat, and lists the Rooms it sits in", async () => {
    const space = await joinedSpace();
    const added = await run(["add", "i_AbCdEfGhIj", "i_KlMnOpQrSt", "--json"], space, [
      { status: 200, body: { admissions: [{ instance_id: "i_AbCdEfGhIj", status: "member", decision_id: null }, { instance_id: "i_KlMnOpQrSt", status: "pending", decision_id: "dec_AbCdEfGhIj" }] } },
    ]);
    expect(added.exitCode).toBe(0);
    expect(added.requests[0]!.url).toBe(`https://sharednet.ai/api/v1/rooms/${ROOM_ID}/members`);
    expect(header(added.requests[0]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    expect(JSON.parse(String(added.requests[0]!.init.body))).toEqual({ with: ["i_AbCdEfGhIj", "i_KlMnOpQrSt"] });
    expect(JSON.parse(added.stdout).admissions[1].status).toBe("pending");

    const malformed = await run(["add", "not-an-id", "--json"], space, []);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.requests).toHaveLength(0);

    const listed = await run(["rooms", "--json"], space, [{ status: 200, body: { items: [{ id: ROOM_ID }] } }]);
    expect(listed.exitCode).toBe(0);
    expect(listed.requests[0]!.url).toBe("https://sharednet.ai/api/v1/rooms");
    expect(listed.requests[0]!.init.method ?? "GET").toBe("GET");
  });

  it("shows the requests waiting on the seat and answers one for itself", async () => {
    const space = await joinedSpace();
    const pending = await run(["requests", "--json"], space, [
      { status: 200, body: { decisions: [{ id: "dec_AbCdEfGhIj", status: "pending", room_id: "rom_KlMnOpQrSt" }] } },
    ]);
    expect(pending.exitCode).toBe(0);
    expect(pending.requests[0]!.url).toBe("https://sharednet.ai/api/v1/decisions?status=pending");

    const accepted = await run(["accept", "dec_AbCdEfGhIj", "--json"], space, [
      { status: 200, body: { decision: { id: "dec_AbCdEfGhIj", status: "approved" }, membership: { room_id: "rom_KlMnOpQrSt", admitted_by: "accepted" } } },
    ]);
    expect(accepted.exitCode).toBe(0);
    expect(accepted.requests[0]!.url).toBe("https://sharednet.ai/api/v1/decisions/dec_AbCdEfGhIj/resolve");
    expect(JSON.parse(String(accepted.requests[0]!.init.body))).toEqual({ resolution: "approved" });

    const denied = await run(["deny", "dec_AbCdEfGhIj", "--json"], space, [
      { status: 200, body: { decision: { id: "dec_AbCdEfGhIj", status: "denied" }, membership: null } },
    ]);
    expect(JSON.parse(String(denied.requests[0]!.init.body))).toEqual({ resolution: "denied" });

    const refused = await run(["accept", "2", "--json"], space, []);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.requests).toHaveLength(0);
  });

  it("waits for at least --min messages across pages before returning", async () => {
    const space = await joinedSpace();
    const result = await run(["wait", "--min", "2", "--json"], space, [
      page([message(2, "one")]),
      page([]),
      page([message(3, "two")]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items.map((item: any) => item.sequence)).toEqual([2, 3]);
    expect(result.requests.map((request) => new URL(request.url).searchParams.get("after"))).toEqual(["1", "2", "2"]);
    const state = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
    expect(state.last_sequence).toBe(3);
  });

  describe("sharednet watch", () => {
    it("wakes the command on a message, hands it the batch, says the answer back, and never wakes on its own words", async () => {
      const space = await joinedSpace();
      const { calls, exec } = recorder({ exitCode: 0, stdout: "On it.\n" });
      const result = await run(
        ["watch", "--on", "message", "--run", "agent-turn", "--reply", "--max-runs", "1", "--json"],
        space,
        [
          { status: 200, body: { instance: { id: MEMBER_ID } } },
          page([own(2, "what I said earlier")]),
          page([]),
          page([message(3, "please review the PR"), own(4, "typing…")]),
          { status: 201, body: { message: { ...own(5, "On it."), id: "msg_reply00001" } } },
        ],
        {},
        { exec },
      );
      expect(result.stderr).not.toContain("snk_");
      expect(result.exitCode).toBe(0);
      // The seat's own message at #2 did not wake it; #3 from the host did, with #4 (own) filtered out.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe("agent-turn");
      expect(calls[0]!.input).toMatchObject({ room_id: ROOM_ID, member_id: MEMBER_ID, trigger: "message" });
      expect((calls[0]!.input as any).messages.map((item: any) => item.sequence)).toEqual([3]);
      expect(calls[0]!.env).toMatchObject({ SHAREDNET_ROOM_ID: ROOM_ID, SHAREDNET_MEMBER_ID: MEMBER_ID, SHAREDNET_MESSAGE_COUNT: "1", SHAREDNET_LAST_SEQUENCE: "4" });
      const reply = result.requests.at(-1)!;
      expect(reply.url).toBe(`https://sharednet.ai/api/v1/rooms/${ROOM_ID}/messages`);
      expect(JSON.parse(String(reply.init.body))).toEqual({ content: "On it." });
      const summary = JSON.parse(result.stdout);
      expect(summary.runs).toEqual([
        { run: 1, trigger: "message", messages: 1, exit_code: 0, reply_message_id: "msg_reply00001", last_sequence: 4 },
      ]);
      const state = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
      expect(state.last_sequence).toBe(4);
    });

    it("waits for --on count N before waking, and does not reply when the command fails", async () => {
      const space = await joinedSpace();
      const { calls, exec } = recorder({ exitCode: 3, stdout: "half an answer", stderr: "boom" });
      const result = await run(
        ["watch", "--on", "count", "2", "--run", "agent-turn", "--reply", "--max-runs", "1", "--json"],
        space,
        [
          { status: 200, body: { instance: { id: MEMBER_ID } } },page([message(2, "first")]), page([message(3, "second")])],
        {},
        { exec },
      );
      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect((calls[0]!.input as any).messages.map((item: any) => item.sequence)).toEqual([2, 3]);
      // Identity, two polls, and no reply posted.
      expect(result.requests).toHaveLength(3);
      expect(result.requests.some((request) => request.init.method === "POST")).toBe(false);
      expect(result.stderr).toContain("boom");
      expect(JSON.parse(result.stdout).runs[0]).toMatchObject({ trigger: "count 2", messages: 2, exit_code: 3, reply_message_id: null });
    });

    it("wakes every interval even when the Room is quiet, and after idle once it has gone quiet", async () => {
      const space = await joinedSpace();
      let clock = Date.parse("2026-09-06T12:00:00Z");
      const now = () => new Date(clock);
      const ticking = recorder({ exitCode: 0, stdout: "" });
      const every = await run(
        ["watch", "--on", "every 10m", "--run", "tick", "--max-runs", "1", "--json"],
        space,
        [
          { status: 200, body: { instance: { id: MEMBER_ID } } },
          { status: 200, body: { items: [], next_cursor: null, has_more: false } },
          { status: 200, body: { items: [], next_cursor: null, has_more: false } },
        ],
        {},
        { exec: async (...call) => { clock += 5 * 60_000; return ticking.exec(...call); }, now: () => { clock += 5 * 60_000; return new Date(clock); } },
      );
      expect(every.exitCode).toBe(0);
      expect(ticking.calls).toHaveLength(1);
      expect((ticking.calls[0]!.input as any).messages).toEqual([]);

      clock = Date.parse("2026-09-06T13:00:00Z");
      const idle = recorder({ exitCode: 0, stdout: "" });
      let polls = 0;
      const quiet = await run(
        ["watch", "--on", "idle 30s", "--run", "digest", "--max-runs", "1", "--json"],
        space,
        [
          { status: 200, body: { instance: { id: MEMBER_ID } } },page([message(2, "a")]), page([message(3, "b")]), page([])],
        {},
        {
          exec: idle.exec,
          now: () => {
            // Time passes only once the Room has gone quiet: the third poll comes back empty after 30 s.
            polls += 1;
            if (polls > 6) clock += 31_000;
            return new Date(clock);
          },
        },
      );
      expect(quiet.exitCode).toBe(0);
      expect(idle.calls).toHaveLength(1);
      expect((idle.calls[0]!.input as any).messages.map((item: any) => item.sequence)).toEqual([2, 3]);
      expect(JSON.parse(quiet.stdout).runs[0]).toMatchObject({ trigger: "idle 30s", messages: 2 });
      void now;
    });

    it("runs a real shell command against the real server and says its output back", async () => {
      // No exec override: the default runner spawns `sh -c`. `cat` echoes the
      // batch, so the reply is the JSON the command was handed.
      const DEV_KEY = `snk_${"a".repeat(43)}`;
      const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
      const fetch: typeof globalThis.fetch = (input, init) => handleRequest(new Request(input as string | URL, init), store);
      const api = async (path: string, init: RequestInit) => {
        const response = await fetch(`http://127.0.0.1:3001/api/v1${path}`, init);
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      };
      const host = await api("/instances", {
        method: "POST",
        headers: { authorization: `Bearer ${DEV_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.0" }),
      });
      const created = await api("/rooms", {
        method: "POST",
        headers: { authorization: `Bearer ${host.body.token}`, "content-type": "application/json", "idempotency-key": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f" },
        body: JSON.stringify({ name: "Watched" }),
      });
      const roomId = created.body.room.id as string;
      const { token: invite } = await store.createRoomInvite({ roomId: roomId as `rom_${string}`, principalId: host.body.instance.principal_id });

      const space = await workspace();
      const { mkdir } = await import("node:fs/promises");
      await mkdir(space.project, { recursive: true });
      const cli = async (argv: string[]) => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const exitCode = await runCli(argv, {
          env: { ...space.env, SHAREDNET_BASE_URL: "http://127.0.0.1:3001" },
          fetch,
          cwd: space.project,
          sleep: async () => undefined,
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
        });
        return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
      };
      expect((await cli(["join", `ROOM=${roomId} TOKEN=${invite}`, "--name", "watcher", "--json"])).exitCode).toBe(0);
      await api(`/rooms/${roomId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.body.token}`, "content-type": "application/json", "idempotency-key": "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a" },
        body: JSON.stringify({ content: "hello watcher" }),
      });

      const watched = await cli(["watch", "--on", "message", "--run", "cat", "--reply", "--max-runs", "1", "--json"]);
      expect(watched.exitCode).toBe(0);
      const summary = JSON.parse(watched.stdout);
      expect(summary.runs[0]).toMatchObject({ messages: 1, exit_code: 0 });
      expect(summary.runs[0].reply_message_id).toMatch(/^msg_/);

      const log = await api(`/rooms/${roomId}/messages?after=0&limit=10`, { headers: { authorization: `Bearer ${host.body.token}` } });
      const reply = log.body.items.find((item: any) => item.id === summary.runs[0].reply_message_id);
      const handed = JSON.parse(reply.content);
      expect(handed.trigger).toBe("message");
      expect(handed.messages.map((item: any) => item.content)).toEqual(["hello watcher"]);
      expect(reply.sender.name).toBe("watcher");
    });

    it("refuses a trigger it does not know, before touching the network", async () => {
      const space = await joinedSpace();
      const result = await run(["watch", "--on", "sometimes", "--run", "x", "--json"], space, []);
      expect(result.exitCode).not.toBe(0);
      expect(result.requests).toHaveLength(0);
      const noCommand = await run(["watch", "--on", "message", "--json"], space, []);
      expect(noCommand.exitCode).not.toBe(0);
    });
  });

  it("waits from the last sequence seen, loops past an empty page, and advances the cursor", async () => {
    const space = await joinedSpace();
    const result = await run(["wait", "--json"], space, [
      { status: 200, body: { items: [], next_cursor: null, has_more: false } },
      {
        status: 200,
        body: {
          items: [message(2, "Any objections?"), message(3, "None here", "codex")],
          next_cursor: "3",
          has_more: false,
        },
      },
    ]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.requests.map((request) => request.url)).toEqual([
      `https://sharednet.ai/api/v1/rooms/${ROOM_ID}/wait?after=1&timeout=25`,
      `https://sharednet.ai/api/v1/rooms/${ROOM_ID}/wait?after=1&timeout=25`,
    ]);
    expect(header(result.requests[1]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    expect(JSON.parse(result.stdout).items.map((item: { sequence: number }) => item.sequence)).toEqual([2, 3]);
    const state = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
    expect(state.last_sequence).toBe(3);
  });

  it("returns after --timeout 0 with an empty page instead of sitting", async () => {
    const space = await joinedSpace();
    const result = await run(["wait", "--timeout", "0", "--json"], space, [
      { status: 200, body: { items: [], next_cursor: null, has_more: false } },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.url).toContain("after=1&timeout=0");
    expect(JSON.parse(result.stdout).items).toEqual([]);
  });

  it("prints plain lines for a hook, and nothing when the Room was quiet", async () => {
    const space = await joinedSpace();
    const quiet = await run(["wait", "--hook"], space, [
      { status: 200, body: { items: [], next_cursor: null, has_more: false } },
    ]);
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stdout).toBe("");
    expect(quiet.requests[0]!.url).toContain("timeout=0");

    const spoken = await run(["wait", "--hook"], space, [
      { status: 200, body: { items: [message(2, "Ship it")], next_cursor: "2", has_more: false } },
    ]);
    expect(spoken.exitCode).toBe(0);
    expect(spoken.stdout).toBe("#2 host: Ship it\n");
  });

  it("tells a directory that never joined what to run", async () => {
    const space = await workspace();
    const result = await run(["say", "hello", "--json"], space, []);

    expect(result.exitCode).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(JSON.parse(result.stderr).error.code).toBe("not_in_a_room");
  });
});

describe("the guest verbs against the real request handler", () => {
  const DEV_KEY = `snk_${"a".repeat(43)}`;
  const UUID = "0f7f2c1e-4d6b-4b6e-8f1a-2b3c4d5e6f70";

  it("joins by invite, speaks, and hears the host reply, with the server the CLI actually ships", async () => {
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const fetch: typeof globalThis.fetch = (input, init) =>
      handleRequest(new Request(input as string | URL, init), store);
    const api = async (path: string, init: RequestInit) => {
      const response = await fetch(`http://127.0.0.1:3001/api/v1${path}`, init);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };

    // A host Instance opens the Room and says one thing before anyone arrives.
    const started = await api("/instances", {
      method: "POST",
      headers: { authorization: `Bearer ${DEV_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.0" }),
    });
    expect(started.status).toBe(201);
    const hostToken = started.body.token as string;
    const created = await api("/rooms", {
      method: "POST",
      headers: {
        authorization: `Bearer ${hostToken}`,
        "content-type": "application/json",
        "idempotency-key": UUID,
      },
      body: JSON.stringify({ name: "Release triage" }),
    });
    expect(created.status).toBe(201);
    const roomId = created.body.room.id as string;
    const welcome = await api(`/rooms/${roomId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${hostToken}`,
        "content-type": "application/json",
        "idempotency-key": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      },
      body: JSON.stringify({ content: "Welcome" }),
    });
    expect(welcome.status).toBe(201);
    const { token: invite } = await store.createRoomInvite({
      roomId: roomId as `rom_${string}`,
      principalId: started.body.instance.principal_id,
    });

    const space = await workspace();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(space.project, { recursive: true });
    const cli = async (argv: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(argv, {
        env: { ...space.env, SHAREDNET_BASE_URL: "http://127.0.0.1:3001" },
        fetch,
        cwd: space.project,
        sleep: async () => undefined,
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      });
      return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
    };

    const joinRun = await cli(["join", `ROOM=${roomId} TOKEN=${invite}`, "--name", "claude-code", "--json"]);
    expect(joinRun.stderr).toBe("");
    expect(joinRun.exitCode).toBe(0);
    const seat = JSON.parse(joinRun.stdout);
    expect(seat.member_id).toMatch(/^i_[A-Za-z0-9]{10}$/);
    expect(seat.last_sequence).toBe(1);
    expect(seat.history.items.map((item: { content: string }) => item.content)).toEqual(["Welcome"]);

    const sayRun = await cli(["say", "Hello from the CLI", "--json"]);
    expect(sayRun.stderr).toBe("");
    expect(sayRun.exitCode).toBe(0);
    expect(JSON.parse(sayRun.stdout).message).toMatchObject({
      sequence: 2,
      content: "Hello from the CLI",
      sender: { member_id: seat.member_id, kind: "guest", name: "claude-code" },
    });

    // The host answers; the guest's wait returns everything after its cursor, in order.
    const reply = await api(`/rooms/${roomId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${hostToken}`,
        "content-type": "application/json",
        "idempotency-key": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      },
      body: JSON.stringify({ content: "Heard you" }),
    });
    expect(reply.status).toBe(201);
    const waitRun = await cli(["wait", "--json"]);
    expect(waitRun.stderr).toBe("");
    expect(waitRun.exitCode).toBe(0);
    expect(JSON.parse(waitRun.stdout).items.map((item: { sequence: number; content: string }) => [item.sequence, item.content])).toEqual([
      [2, "Hello from the CLI"],
      [3, "Heard you"],
    ]);

    // Nothing new: a bounded wait comes back empty and leaves the cursor alone.
    const quiet = await cli(["wait", "--timeout", "0", "--json"]);
    expect(quiet.exitCode).toBe(0);
    expect(JSON.parse(quiet.stdout).items).toEqual([]);
    const state = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
    expect(state.last_sequence).toBe(3);
  });
});
