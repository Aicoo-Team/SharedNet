// @vitest-environment node

import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { MemorySharedNetRepository } from "@/packages/server/src/memory-repository.ts";
import { createSharedNetMcpServer, parseInviteText } from "./server";

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
    expect(names).toEqual(["accept", "deny", "join", "read", "requests", "room_create", "room_invite", "rooms", "say", "wait", "whoami"]);

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
    // read from 0 is the whole log, both seats named as Instances of their accounts.
    const read = tool((await guest("tools/call", { name: "read", arguments: { room_id: created.room_id, after: 0 } })).body) as { messages: Array<{ from: { kind: string; principal_id: string } }> };
    expect(read.messages.map((m) => m.from.kind)).toEqual(["instance", "instance"]);
    expect(new Set(read.messages.map((m) => m.from.principal_id)).size).toBe(2);
    // The Rooms list shows the guest its seat.
    const rooms = tool((await guest("tools/call", { name: "rooms", arguments: {} })).body) as { rooms: Array<{ room_id: string; members: number }> };
    expect(rooms.rooms.map((r) => [r.room_id, r.members])).toEqual([[created.room_id, 2]]);
  });

  it("refuses what the domain refuses, in the domain's words", async () => {
    const { handler } = world();
    const call = rpc(handler, chatgpt);
    const refused = tool((await call("tools/call", { name: "room_invite", arguments: { room_id: "rom_nowhere001" } })).body) as { error: string };
    expect(refused.error).toContain("room_not_found");
    const bad = await call("tools/call", { name: "join", arguments: { invite: "nonsense" } });
    expect(tool(bad.body)).toMatchObject({ error: expect.stringContaining("room_id") });
  });

  it("reads an invite in every shape the site hands out", () => {
    const token = `rit_${"t".repeat(43)}`;
    expect(parseInviteText(`ROOM=rom_AbCdEfGhIj TOKEN=${token} BASE=https://www.sharednet.ai`)).toEqual({ roomId: "rom_AbCdEfGhIj", token });
    expect(parseInviteText(`Join SharedNet Room rom_AbCdEfGhIj ("x").\nROOM=rom_AbCdEfGhIj\nTOKEN=${token}\nBASE=https://www.sharednet.ai`)).toEqual({ roomId: "rom_AbCdEfGhIj", token });
    expect(parseInviteText(`https://www.sharednet.ai/join/${token}`)).toEqual({ roomId: null, token });
    expect(parseInviteText("nothing here")).toEqual({ roomId: null, token: null });
  });
});
