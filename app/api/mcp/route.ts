import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";

import { getAuth, mcpResourceUrl } from "../../../lib/auth";
import { oauthClient } from "@/packages/db/src/auth-schema.ts";
import { getDatabase } from "@/packages/db/src/client.ts";
import { PostgresSharedNetRepository } from "@/packages/server/src/postgres-repository.ts";
import { createSharedNetMcpServer, mcpClientFrom, type McpSubject } from "@/src/mcp/server";

/** The name a client registered under, which is how a connector says it is ChatGPT or Claude. */
async function registeredName(clientId: string): Promise<string | null> {
  const [row] = await getDatabase().select({ name: oauthClient.name }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  return row?.name ?? null;
}

/**
 * The remote MCP endpoint ChatGPT and Claude connect to. Better Auth verifies
 * the bearer token against its own keys and hands over the claims; the
 * subject (the signed-in account) and the client (which product) decide the
 * Instance the connection acts as. Every tool is one of the API's doors.
 */
const handler = createMcpHandler(
  (context) => {
    const extra = (context.authInfo?.extra ?? {}) as Partial<McpSubject>;
    if (!extra.userId || !extra.client) throw new Error("MCP request without a verified subject");
    return createSharedNetMcpServer(
      { userId: extra.userId, client: extra.client },
      { repository: new PostgresSharedNetRepository(getDatabase()), origin: new URL(mcpResourceUrl(process.env.BETTER_AUTH_URL ?? "")).origin },
    );
  },
  { legacy: "stateless" },
);

function protectedHandler(request: Request): Promise<Response> {
  const resource = mcpResourceUrl(process.env.BETTER_AUTH_URL ?? "");
  const guarded = requireMcpAuth(
    getAuth(),
    async (verifiedRequest, claims) => {
      const record = claims as Record<string, unknown>;
      const clientId = typeof record.client_id === "string" ? record.client_id : typeof record.azp === "string" ? record.azp : "unknown";
      const subject: McpSubject = { userId: String(record.sub), client: mcpClientFrom(clientId, await registeredName(clientId)) };
      const scopes = typeof record.scope === "string" ? record.scope.split(" ").filter(Boolean) : [];
      return handler.fetch(verifiedRequest, {
        authInfo: { token: verifiedRequest.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "", clientId: subject.client.id, scopes, extra: subject },
      });
    },
    { resource },
  );
  return guarded(request);
}

export const GET = protectedHandler;
export const POST = protectedHandler;
export const DELETE = protectedHandler;
