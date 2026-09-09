// @vitest-environment node
// A probe, kept as a test so the handshake a chat client performs stays covered.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { MemorySharedNetRepository } from "@/packages/server/src/memory-repository.ts";
import { createSharedNetMcpServer } from "./server";

const subject = { userId: "u1", client: { id: "c1", label: "ChatGPT" } };

function handler() {
  const repository = new MemorySharedNetRepository({ accounts: [{ authUserId: "u1" }] });
  return createMcpHandler((ctx) => createSharedNetMcpServer(ctx.authInfo!.extra as unknown as typeof subject, { repository, origin: "https://www.sharednet.ai" }));
}

async function post(h: ReturnType<typeof handler>, body: unknown) {
  const r = await h.fetch(
    new Request("https://www.sharednet.ai/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }),
    { authInfo: { token: "t", clientId: "c1", scopes: [], extra: subject } },
  );
  const t = await r.text();
  const d = t.trim().startsWith("{") ? t : (t.split("\n").filter((l) => l.startsWith("data:")).at(-1) ?? "{}").slice(5);
  return { status: r.status, body: JSON.parse(d || "{}") as { result?: Record<string, unknown>; error?: { message: string } } };
}

describe("what a chat client sees", () => {
  it("answers initialize for the protocol versions chat clients speak", async () => {
    const h = handler();
    const seen: Record<string, unknown> = {};
    for (const version of ["2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28"]) {
      const r = await post(h, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "ChatGPT", version: "1" } } });
      seen[version] = r.body.result?.protocolVersion ?? r.body.error?.message ?? "no result";
      expect(r.status, `${version}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.result, `${version} was refused: ${JSON.stringify(r.body.error)}`).toBeDefined();
    }
    console.log("initialize:", JSON.stringify(seen));
  });

  it("lists tools whose schemas a strict client can read", async () => {
    const list = await post(handler(), { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (list.body.result?.tools ?? []) as Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }>;
    expect(tools).toHaveLength(13);
    // Every tool says whether it only reads, so a chat client can auto-approve the safe ones.
    const byName = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));
    for (const name of ["whoami", "rooms", "read", "wait", "requests", "search", "fetch"]) expect(byName.get(name)).toMatchObject({ readOnlyHint: true });
    for (const name of ["room_create", "room_invite", "join", "say", "accept", "deny"]) expect(byName.get(name)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const tool of tools) {
      expect(tool.inputSchema.type, `${tool.name} schema: ${JSON.stringify(tool.inputSchema)}`).toBe("object");
      expect(tool.inputSchema).toHaveProperty("properties");
      expect(typeof tool.description).toBe("string");
    }
    console.log("whoami schema:", JSON.stringify(tools.find((t) => t.name === "whoami")?.inputSchema));
    console.log("read schema:", JSON.stringify(tools.find((t) => t.name === "read")?.inputSchema).slice(0, 400));
    console.log("annotations:", JSON.stringify(tools.map((t) => [t.name, t.annotations ?? null])));
  });

  it("answers a stream open the way the transport expects", async () => {
    const r = await handler().fetch(new Request("https://www.sharednet.ai/api/mcp", { method: "GET", headers: { accept: "text/event-stream" } }), {
      authInfo: { token: "t", clientId: "c1", scopes: [], extra: subject },
    });
    console.log("GET:", r.status, await r.text());
    expect([200, 405]).toContain(r.status);
  });
});
