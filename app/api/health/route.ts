import { sql } from "drizzle-orm";

import { getDatabase } from "@/packages/db/src/client.ts";

/**
 * Operational readiness, deliberately outside the versioned /api/v1 contract.
 *
 * This executes a real query rather than checking that DATABASE_URL is set.
 * getAuth() is lazily memoised so Next can import route modules during a build,
 * which means a deployment with no reachable database still boots cleanly and
 * only fails on the first live auth request — a 500 with no crash loop, so
 * nothing rolls back on its own. Gate the deployment on this endpoint instead.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = {
  "cache-control": "no-store, max-age=0",
  "cdn-cache-control": "no-store",
  "vercel-cdn-cache-control": "no-store",
} as const;

export async function GET(): Promise<Response> {
  const startedAt = Date.now();

  try {
    await getDatabase().execute(sql`select 1`);
  } catch {
    // The cause can carry the connection string or credentials; never surface it.
    return Response.json(
      { status: "unavailable", database: "unreachable" },
      { status: 503, headers: NO_STORE },
    );
  }

  return Response.json(
    { status: "ok", database: "reachable", latency_ms: Date.now() - startedAt },
    { status: 200, headers: NO_STORE },
  );
}
