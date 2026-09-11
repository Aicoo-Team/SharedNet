// @vitest-environment node

import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { InstanceId, PrincipalId, RoomId } from "@/packages/protocol/src/index.ts";
import { MemorySharedNetRepository } from "@/packages/server/src/memory-repository.ts";
import { runtimeKindForMcp } from "@/packages/server/src/memory-repository.ts";
import { createSharedNetMcpServer, mcpClientFrom, parseInviteText } from "./server";

const ORIGIN = "https://www.sharednet.ai";

/** Drive the server the way a client does: JSON-RPC over the handler's fetch, one stateless request at a time. */
function rpc(handler: ReturnType<typeof createMcpHandler>, subject: { userId: string; client: { id: string; label: string } }) {
  let id = 0;
  return async (method: string, params: unknown) => {
    id += 1;
    const response = await handler.fetch(
      new Request("https://www.sharednet.ai/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
      { authInfo: { token: "t", clientId: subject.client.id, scopes: [], extra: subject } },
    );
    const text = await response.text();
    // The stateless legacy leg may answer as SSE; take the last data line either way.
    const json = text.trim().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5);
    return { status: response.status, body: JSON.parse(json) as { result?: Record<string, unknown>; error?: { message: string } } };
  };
}

function tool(body: { result?: Record<string, unknown> }) {
  const result = body.result as { structuredContent?: Record<string, unknown>; isError?: boolean; content: Array<{ text: string }> };
  return result.isError ? { error: result.content[0]!.text } : result.structuredContent!;
}

describe("SharedNet over MCP", () => {
  const chatgpt = { userId: "auth-user-1", client: { id: "client_chatgpt", label: "ChatGPT" } };
  const claude = { userId: "auth-user-2", client: { id: "client_claude", label: "Claude" } };

  function world() {
    const repository = new MemorySharedNetRepository({ accounts: [{ authUserId: "auth-user-1", displayName: "Xisen" }, { authUserId: "auth-user-2" }] });
    const handler = createMcpHandler((context) => createSharedNetMcpServer(context.authInfo!.extra as typeof chatgpt, { repository, origin: ORIGIN, sleep: async () => {}, now: () => Date.now() }));
    return { repository, handler };
  }

  it("lists its tools, and acts as one Instance of the account per client", async () => {
    const { handler, repository } = world();
    const call = rpc(handler, chatgpt);
    const listed = await call("tools/list", {});
    const names = (listed.body.result!.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual([
      "accept",
      "credits",
      "deny",
      "fetch",
      "file_read",
      "file_write",
      "files",
      "join",
      "pay",
      "read",
      "redeem_credits",
      "requests",
      "room_create",
      "room_invite",
      "rooms",
      "say",
      "search",
      "wait",
      "whoami",
    ]);

    const who = tool((await call("tools/call", { name: "whoami", arguments: {} })).body) as Record<string, string>;
    expect(who.principal_id).toMatch(/^p_/);
    expect(who.instance_id).toMatch(/^i_/);
    expect(who.runtime_kind).toBe("chatgpt");
    // The same client on the same account is the same Instance; another client is another.
    const again = tool((await call("tools/call", { name: "whoami", arguments: {} })).body) as Record<string, string>;
    expect(again.instance_id).toBe(who.instance_id);
    const other = tool((await rpc(handler, { userId: "auth-user-1", client: { id: "client_claude", label: "Claude" } })("tools/call", { name: "whoami", arguments: {} })).body) as Record<string, string>;
    expect(other.instance_id).not.toBe(who.instance_id);
    expect(other.runtime_kind).toBe("claude-ai");
    expect(other.principal_id).toBe(who.principal_id);
    // The Instance is a real one: the Dashboard's Network sees it.
    const network = await repository.networkForPrincipal(who.principal_id as never);
    expect(network.instances.map((i) => i.id).sort()).toEqual([who.instance_id, other.instance_id].sort());
  });

  it("creates a Room, mints the invite with the link, and lets another account's client join by it, read, say, and wait", async () => {
    const { handler } = world();
    const host = rpc(handler, chatgpt);
    const guest = rpc(handler, claude);

    const created = tool((await host("tools/call", { name: "room_create", arguments: { name: "Launch review" } })).body) as Record<string, string>;
    expect(created.room_id).toMatch(/^rom_/);
    const invite = tool((await host("tools/call", { name: "room_invite", arguments: { room_id: created.room_id } })).body) as Record<string, string>;
    expect(invite.link).toMatch(new RegExp(`^${ORIGIN}/join/rit_`));
    expect(invite.for_agents).toContain(`ROOM=${created.room_id} TOKEN=rit_`);
    expect(invite.command).toContain("npx -y sharednet@latest join");

    const joined = tool((await guest("tools/call", { name: "join", arguments: { invite: invite.for_agents } })).body) as Record<string, unknown>;
    expect(joined.room_id).toBe(created.room_id);
    expect(joined.admitted_by).toBe("invite");
    expect(joined.member_id).toMatch(/^i_/);

    const said = tool((await guest("tools/call", { name: "say", arguments: { room_id: created.room_id, content: "Hello from Claude" } })).body) as Record<string, unknown>;
    expect(said.sequence).toBe(1);
    // The host's wait returns the guest's words, not its own, and moves the cursor.
    await host("tools/call", { name: "say", arguments: { room_id: created.room_id, content: "and hello from ChatGPT" } });
    const waited = tool((await host("tools/call", { name: "wait", arguments: { room_id: created.room_id, timeout_seconds: 0 } })).body) as { messages: Array<{ content: string; from: { kind: string } }>; last_sequence: number };
    expect(waited.messages.map((m) => m.content)).toEqual(["Hello from Claude"]);
    expect(waited.last_sequence).toBe(2);
    // Nothing new: an empty page, cursor untouched.
    const quiet = tool((await host("tools/call", { name: "wait", arguments: { room_id: created.room_id, timeout_seconds: 0 } })).body) as { messages: unknown[]; last_sequence: number };
    expect(quiet.messages).toEqual([]);
    expect(quiet.last_sequence).toBe(2);
    // read is newest first, and both seats are named as Instances of their accounts.
    const read = tool((await guest("tools/call", { name: "read", arguments: { room_id: created.room_id } })).body) as { messages: Array<{ sequence: number; from: { kind: string; principal_id: string } }>; query: Record<string, unknown> };
    expect(read.messages.map((m) => m.sequence)).toEqual([2, 1]);
    expect(read.query).toMatchObject({ order: "newest first", limit: 20, grep: null });
    expect(read.messages.map((m) => m.from.kind)).toEqual(["instance", "instance"]);
    expect(new Set(read.messages.map((m) => m.from.principal_id)).size).toBe(2);
    // The Rooms list shows the guest its seat.
    const rooms = tool((await guest("tools/call", { name: "rooms", arguments: {} })).body) as { rooms: Array<{ room_id: string; members: number }> };
    expect(rooms.rooms.map((r) => [r.room_id, r.members])).toEqual([[created.room_id, 2]]);
  });

  it("looks one thing up by grep, sender and direction, and never moves the wait cursor", async () => {
    const { handler } = world();
    const host = rpc(handler, chatgpt);
    const guest = rpc(handler, claude);
    const hostId = (tool((await host("tools/call", { name: "whoami", arguments: {} })).body) as Record<string, string>).instance_id;
    const room = (tool((await host("tools/call", { name: "room_create", arguments: { name: "Standing decisions" } })).body) as Record<string, string>).room_id;
    const invite = tool((await host("tools/call", { name: "room_invite", arguments: { room_id: room } })).body) as Record<string, string>;
    await guest("tools/call", { name: "join", arguments: { invite: invite.for_agents } });
    for (const line of ["The deploy window opens Tuesday 14:00 UTC", "unrelated chatter about the logo", "Correction: the deploy window opens Tuesday 15:00 UTC"]) {
      await host("tools/call", { name: "say", arguments: { room_id: room, content: line } });
    }
    await guest("tools/call", { name: "say", arguments: { room_id: room, content: "noted, deploy window understood" } });

    // Newest first, so one match is the current statement rather than the first ever made.
    const found = tool((await guest("tools/call", { name: "read", arguments: { room_id: room, grep: "deploy window", limit: 1 } })).body) as { messages: Array<{ content: string }> };
    expect(found.messages.map((m) => m.content)).toEqual(["noted, deploy window understood"]);
    const fromHost = tool((await guest("tools/call", { name: "read", arguments: { room_id: room, grep: "deploy window", from_instance: hostId, limit: 1 } })).body) as { messages: Array<{ content: string }> };
    expect(fromHost.messages[0]!.content).toBe("Correction: the deploy window opens Tuesday 15:00 UTC");
    const oldest = tool((await guest("tools/call", { name: "read", arguments: { room_id: room, oldest_first: true, limit: 1 } })).body) as { messages: Array<{ sequence: number }> };
    expect(oldest.messages[0]!.sequence).toBe(1);
    // None of that moved the cursor, so wait still hands over everything unseen.
    const waited = tool((await guest("tools/call", { name: "wait", arguments: { room_id: room, timeout_seconds: 0 } })).body) as { messages: Array<{ sequence: number }> };
    expect(waited.messages.map((m) => m.sequence)).toEqual([1, 2, 3]);
  });

  it("returns a read cursor that retrieves the next older matches without repeating them", async () => {
    const { handler } = world();
    const host = rpc(handler, chatgpt);
    const room = (tool((await host("tools/call", { name: "room_create", arguments: { name: "Paged decisions" } })).body) as Record<string, string>).room_id;
    for (const content of ["decision one", "chatter", "decision two", "more chatter", "decision three"]) {
      await host("tools/call", { name: "say", arguments: { room_id: room, content } });
    }

    type ReadPage = { messages: Array<{ sequence: number }>; next_cursor: string | null; has_more: boolean; wait_cursor: number };
    const first = tool((await host("tools/call", { name: "read", arguments: { room_id: room, grep: "decision", limit: 2 } })).body) as ReadPage;
    expect(first.messages.map((message) => message.sequence)).toEqual([5, 3]);
    expect(first).toMatchObject({ next_cursor: "3", has_more: true, wait_cursor: 0 });
    const next = tool((await host("tools/call", { name: "read", arguments: { room_id: room, grep: "decision", limit: 2, before: Number(first.next_cursor) } })).body) as ReadPage;
    expect(next.messages.map((message) => message.sequence)).toEqual([1]);
    expect(next).toMatchObject({ next_cursor: "1", has_more: false, wait_cursor: 0 });
  });

  it("keeps two conversations of one connector independent when each passes its own place", async () => {
    const { handler } = world();
    const host = rpc(handler, chatgpt);
    // Two conversations of the same connector: the same client, the same account, so the same seat.
    const conversationA = rpc(handler, claude);
    const conversationB = rpc(handler, claude);
    const room = (tool((await host("tools/call", { name: "room_create", arguments: { name: "Two conversations" } })).body) as Record<string, string>).room_id;
    const invite = tool((await host("tools/call", { name: "room_invite", arguments: { room_id: room } })).body) as Record<string, string>;
    await conversationA("tools/call", { name: "join", arguments: { invite: invite.for_agents } });
    await host("tools/call", { name: "say", arguments: { room_id: room, content: "first" } });
    await host("tools/call", { name: "say", arguments: { room_id: room, content: "second" } });

    // A reads along and consumes both; the shared cursor moves.
    const a = tool((await conversationA("tools/call", { name: "wait", arguments: { room_id: room, timeout_seconds: 0 } })).body) as { messages: Array<{ content: string }>; last_sequence: number };
    expect(a.messages.map((m) => m.content)).toEqual(["first", "second"]);
    // B, which was following from the start, is not robbed of them: it says where it is.
    const b = tool((await conversationB("tools/call", { name: "wait", arguments: { room_id: room, after: 0, timeout_seconds: 0 } })).body) as { messages: Array<{ content: string }> };
    expect(b.messages.map((m) => m.content)).toEqual(["first", "second"]);
    // And B's older place never drags the shared cursor backwards for a fresh conversation.
    const fresh = tool((await rpc(handler, claude)("tools/call", { name: "wait", arguments: { room_id: room, timeout_seconds: 0 } })).body) as { messages: unknown[]; last_sequence: number };
    expect(fresh.messages).toEqual([]);
    expect(fresh.last_sequence).toBe(a.last_sequence);
  });

  it("searches every Room the account can see and expands one hit, in the shape a chat client reads", async () => {
    const { handler } = world();
    const host = rpc(handler, chatgpt);
    const first = (tool((await host("tools/call", { name: "room_create", arguments: { name: "Launch review" } })).body) as Record<string, string>).room_id;
    const second = (tool((await host("tools/call", { name: "room_create", arguments: { name: "Hiring" } })).body) as Record<string, string>).room_id;
    await host("tools/call", { name: "say", arguments: { room_id: first, content: "the deploy window opens Tuesday 14:00 UTC" } });
    await host("tools/call", { name: "say", arguments: { room_id: second, content: "unrelated: the offer letter is out" } });

    const found = tool((await host("tools/call", { name: "search", arguments: { query: "deploy window" } })).body) as { results: Array<{ id: string; title: string; url: string }> };
    expect(found.results).toHaveLength(1);
    const hit = found.results[0]!;
    expect(hit.id).toMatch(new RegExp(`^${first}:msg_`));
    expect(hit.title).toContain("Launch review");
    // A citation needs a non-empty url.
    expect(hit.url).toBe(`https://www.sharednet.ai/chat?room=${first}`);

    const doc = tool((await host("tools/call", { name: "fetch", arguments: { id: hit.id } })).body) as { text: string; metadata: Record<string, string>; url: string };
    expect(doc.text).toBe("the deploy window opens Tuesday 14:00 UTC");
    expect(doc.metadata.room_id).toBe(first);
    expect(doc.url).toBe(hit.url);
    expect(tool((await host("tools/call", { name: "fetch", arguments: { id: "nonsense" } })).body)).toMatchObject({ error: expect.stringContaining("rom_") });
  });

  it("expands a search hit even after more than a hundred newer messages", async () => {
    const { handler } = world();
    const host = rpc(handler, chatgpt);
    const room = (tool((await host("tools/call", { name: "room_create", arguments: { name: "Long history" } })).body) as Record<string, string>).room_id;
    await host("tools/call", { name: "say", arguments: { room_id: room, content: "the original launch decision" } });
    for (let i = 0; i < 101; i += 1) {
      await host("tools/call", { name: "say", arguments: { room_id: room, content: `later chatter ${i}` } });
    }

    const found = tool((await host("tools/call", { name: "search", arguments: { query: "original launch decision" } })).body) as { results: Array<{ id: string }> };
    expect(found.results).toHaveLength(1);
    const doc = tool((await host("tools/call", { name: "fetch", arguments: { id: found.results[0]!.id } })).body);
    expect(doc).toMatchObject({ text: "the original launch decision", metadata: { room_id: room, sequence: "1" } });
  });

  it("only fetches a message from the Room named in the result id", async () => {
    const { handler } = world();
    const host = rpc(handler, chatgpt);
    const first = (tool((await host("tools/call", { name: "room_create", arguments: { name: "First" } })).body) as Record<string, string>).room_id;
    const second = (tool((await host("tools/call", { name: "room_create", arguments: { name: "Second" } })).body) as Record<string, string>).room_id;
    const said = tool((await host("tools/call", { name: "say", arguments: { room_id: first, content: "only in the first Room" } })).body) as Record<string, string>;

    expect(tool((await host("tools/call", { name: "fetch", arguments: { id: `${second}:${said.message_id}` } })).body)).toMatchObject({ error: expect.stringContaining("No message") });
    expect(tool((await host("tools/call", { name: "fetch", arguments: { id: `${first}:msg_AbCdEfGhIj` } })).body)).toMatchObject({ error: expect.stringContaining("No message") });
    expect(tool((await host("tools/call", { name: "fetch", arguments: { id: `rom_AbCdEfGhIj:${said.message_id}` } })).body)).toMatchObject({ error: expect.stringContaining("room_not_found") });
  });

  it("requires the fetching Instance to hold an active seat, including after removal", async () => {
    const { handler, repository } = world();
    const host = rpc(handler, chatgpt);
    const guest = rpc(handler, claude);
    const sibling = rpc(handler, { ...chatgpt, client: claude.client });
    const owner = tool((await host("tools/call", { name: "whoami", arguments: {} })).body) as { principal_id: PrincipalId };
    const room = (tool((await host("tools/call", { name: "room_create", arguments: { name: "Members only" } })).body) as { room_id: RoomId }).room_id;
    const said = tool((await host("tools/call", { name: "say", arguments: { room_id: room, content: "private launch decision" } })).body) as Record<string, string>;
    const id = `${room}:${said.message_id}`;

    for (const caller of [guest, sibling]) {
      expect(tool((await caller("tools/call", { name: "fetch", arguments: { id } })).body)).toMatchObject({ error: expect.stringContaining("room_membership_required") });
    }
    const invite = tool((await host("tools/call", { name: "room_invite", arguments: { room_id: room } })).body) as Record<string, string>;
    const joined = tool((await guest("tools/call", { name: "join", arguments: { invite: invite.for_agents } })).body) as { member_id: InstanceId };
    expect(tool((await guest("tools/call", { name: "fetch", arguments: { id } })).body)).toMatchObject({ text: "private launch decision" });
    await repository.removeRoomMember(owner.principal_id, room, joined.member_id);
    expect(tool((await guest("tools/call", { name: "fetch", arguments: { id } })).body)).toMatchObject({ error: expect.stringContaining("room_membership_required") });
  });

  it("refuses what the domain refuses, in the domain's words", async () => {
    const { handler } = world();
    const call = rpc(handler, chatgpt);
    const refused = tool((await call("tools/call", { name: "room_invite", arguments: { room_id: "rom_nowhere001" } })).body) as { error: string };
    expect(refused.error).toContain("room_not_found");
    const bad = await call("tools/call", { name: "join", arguments: { invite: "nonsense" } });
    expect(tool(bad.body)).toMatchObject({ error: expect.stringContaining("room_id") });
  });

  it("names a client by its registration, and reads the product out of the name", async () => {
    expect(mcpClientFrom("client_abc", "ChatGPT")).toEqual({ id: "client_abc", label: "ChatGPT" });
    // No registered name: the id stands for both, and the seat is a plain MCP one.
    expect(mcpClientFrom("client_abc", null)).toEqual({ id: "client_abc", label: "client_abc" });
    expect(mcpClientFrom(null, "")).toEqual({ id: "unknown", label: "unknown" });
    expect(runtimeKindForMcp(mcpClientFrom("client_abc", "ChatGPT"))).toBe("chatgpt");
    expect(runtimeKindForMcp(mcpClientFrom("client_xyz", "Claude"))).toBe("claude-ai");
    expect(runtimeKindForMcp(mcpClientFrom("client_xyz", "Cowork Desktop"))).toBe("cowork-desktop");
    expect(runtimeKindForMcp(mcpClientFrom("client_xyz", null))).toBe("mcp");
  });

  it("reads an invite in every shape the site hands out", () => {
    const token = `rit_${"t".repeat(43)}`;
    expect(parseInviteText(`ROOM=rom_AbCdEfGhIj TOKEN=${token} BASE=https://www.sharednet.ai`)).toEqual({ roomId: "rom_AbCdEfGhIj", token });
    expect(parseInviteText(`Join SharedNet Room rom_AbCdEfGhIj ("x").\nROOM=rom_AbCdEfGhIj\nTOKEN=${token}\nBASE=https://www.sharednet.ai`)).toEqual({ roomId: "rom_AbCdEfGhIj", token });
    expect(parseInviteText(`https://www.sharednet.ai/join/${token}`)).toEqual({ roomId: null, token });
    expect(parseInviteText("nothing here")).toEqual({ roomId: null, token: null });
  });
});

describe("SharedNet over MCP: files and credits", () => {
  const chatgpt = { userId: "auth-user-1", client: { id: "client_chatgpt", label: "ChatGPT" } };
  const claude = { userId: "auth-user-2", client: { id: "client_claude", label: "Claude" } };

  function world() {
    const repository = new MemorySharedNetRepository({
      accounts: [{ authUserId: "auth-user-1", displayName: "Xisen" }, { authUserId: "auth-user-2" }],
      creditCodes: [{ code: "HACK100", amount: 100, max_redemptions: 2 }],
    });
    const handler = createMcpHandler((context) =>
      createSharedNetMcpServer(context.authInfo!.extra as typeof chatgpt, { repository, origin: ORIGIN, sleep: async () => {}, now: () => Date.now() }),
    );
    return { repository, handler };
  }

  it("hands a file to a Room, reads it back as text, and lists it for the other member", async () => {
    const { handler } = world();
    const mine = rpc(handler, chatgpt);
    const theirs = rpc(handler, claude);
    const opened = tool(
      (await mine("tools/call", { name: "room_create", arguments: { name: "Handover" } })).body,
    ) as { room_id: string };
    const invite = tool((await mine("tools/call", { name: "room_invite", arguments: { room_id: opened.room_id } })).body) as { for_agents: string };
    expect(tool((await theirs("tools/call", { name: "join", arguments: { invite: invite.for_agents } })).body)).toMatchObject({ room_id: opened.room_id });

    const written = tool(
      (await mine("tools/call", {
        name: "file_write",
        arguments: { filename: "report.md", text: "# Findings\n\nThe patch applies.\n", room_id: opened.room_id },
      })).body,
    ) as { artifact_id: string; reach: string; next: string };
    expect(written.reach).toBe("room");
    expect(written.artifact_id).toMatch(/^art_[0-9A-Za-z]{10}$/);
    expect(written.next).toContain("Say this id");
    expect(written).not.toHaveProperty("url");

    // The other member sees it and reads it, through its own seat.
    const listed = tool((await theirs("tools/call", { name: "files", arguments: { room_id: opened.room_id } })).body) as {
      files: Array<{ artifact_id: string; filename: string; size_bytes: number }>;
    };
    expect(listed.files.map((file) => file.filename)).toEqual(["report.md"]);
    const read = tool((await theirs("tools/call", { name: "file_read", arguments: { artifact_id: written.artifact_id } })).body);
    expect(read).toMatchObject({ filename: "report.md", text: "# Findings\n\nThe patch applies.\n" });

    // With link: true there is a URL instead, and no Room is needed.
    const published = tool((await mine("tools/call", { name: "file_write", arguments: { filename: "rows.csv", text: "a,b\n1,2\n", link: true } })).body) as {
      artifact_id: string;
      url: string;
    };
    expect(published.url).toBe(`${ORIGIN}/f/${published.artifact_id}?k=${published.url.split("k=")[1]}`);
    expect(published.url).toMatch(/\?k=afk_[A-Za-z0-9_-]{43}$/);
    // A file with no Room and no link is refused with what to do instead.
    expect(tool((await mine("tools/call", { name: "file_write", arguments: { filename: "x.txt", text: "x" } })).body)).toMatchObject({
      error: expect.stringContaining("link: true"),
    });
    // A file of an account this connection is not in a Room with is not there.
    expect(tool((await theirs("tools/call", { name: "file_read", arguments: { artifact_id: published.artifact_id } })).body)).toMatchObject({
      error: expect.stringContaining("artifact_not_found"),
    });
  });

  it("describes rather than returns what is not text, and never guesses at bytes", async () => {
    const { handler, repository } = world();
    const mine = rpc(handler, chatgpt);
    const seat = await repository.mcpSeat(chatgpt.userId, chatgpt.client);
    const png = await repository.uploadArtifact(seat.auth, {
      filename: "shot.png",
      content_type: "image/png",
      reach: "link",
      room_id: null,
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]),
    });

    const read = tool((await mine("tools/call", { name: "file_read", arguments: { artifact_id: png.artifact.id } })).body);
    expect(read).toMatchObject({ filename: "shot.png", text: null, reason: expect.stringContaining("not UTF-8") });
  });

  it("reads the purse, redeems once, and pays another account", async () => {
    const { handler, repository } = world();
    const mine = rpc(handler, chatgpt);
    const theirs = rpc(handler, claude);
    const theirSeat = await repository.mcpSeat(claude.userId, claude.client);

    expect(tool((await mine("tools/call", { name: "credits", arguments: {} })).body)).toMatchObject({ balance: 0, granted: 0 });
    expect(tool((await mine("tools/call", { name: "redeem_credits", arguments: { code: "hack100" } })).body)).toEqual({ granted: 100, balance: 100 });
    // A retry grants nothing and is not an error.
    expect(tool((await mine("tools/call", { name: "redeem_credits", arguments: { code: "HACK100" } })).body)).toEqual({ granted: 0, balance: 100 });

    const paid = tool((await mine("tools/call", { name: "pay", arguments: { to: theirSeat.instance.id, amount: 25, memo: "map tiles" } })).body) as {
      transfer_id: string;
      balance: number;
    };
    expect(paid).toMatchObject({ amount: 25, to: theirSeat.principal.id, balance: 75 });
    expect(paid.transfer_id).toMatch(/^txn_[0-9A-Za-z]{10}$/);
    expect(tool((await theirs("tools/call", { name: "credits", arguments: {} })).body)).toMatchObject({ balance: 25, received: 25 });

    // Over the purse, and to itself, are refused in the domain's own words.
    expect(tool((await mine("tools/call", { name: "pay", arguments: { to: theirSeat.instance.id, amount: 1000 } })).body)).toMatchObject({
      error: expect.stringContaining("insufficient_credits"),
    });
    const ownSeat = await repository.mcpSeat(chatgpt.userId, chatgpt.client);
    expect(tool((await mine("tools/call", { name: "pay", arguments: { to: ownSeat.instance.id, amount: 1 } })).body)).toMatchObject({
      error: expect.stringContaining("transfer_to_self"),
    });
  });
});

