import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { getAuth, mcpResourceUrl } from "../../../lib/auth";
import { getDatabase } from "@/packages/db/src/client.ts";
import { PostgresSharedNetRepository } from "@/packages/server/src/postgres-repository.ts";
import { createSharedNetMcpServer, type McpSubject } from "@/src/mcp/server";

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
    (verifiedRequest, claims) => {
      const record = claims as Record<string, unknown>;
      const clientId = typeof record.client_id === "string" ? record.client_id : typeof record.azp === "string" ? record.azp : "unknown";
      const subject: McpSubject = {
        userId: String(record.sub),
        client: { id: clientId, label: typeof record.client_name === "string" ? record.client_name : clientId },
      };
      const scopes = typeof record.scope === "string" ? record.scope.split(" ").filter(Boolean) : [];
      return handler.fetch(verifiedRequest, {
        authInfo: { token: verifiedRequest.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "", clientId, scopes, extra: subject },
      });
    },
    { resource },
  );
  return guarded(request);
}

export const GET = protectedHandler;
export const POST = protectedHandler;
export const DELETE = protectedHandler;
