import { randomUUID } from "node:crypto";

import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";

import {
  apiKey as apiKeyTable,
  authAccount,
  authJwks,
  authSession,
  authUser,
  authVerification,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
} from "../packages/db/src/auth-schema.ts";
import { getDatabase } from "../packages/db/src/client.ts";
import { principals } from "../packages/db/src/schema.ts";
import {
  generatePublicId,
  generateSecret,
} from "../packages/protocol/src/index.ts";

const POSTGRES_ENVIRONMENT_NAMES = [
  "DATABASE_URL",
  "SHAREDNET_POSTGRES_URL",
] as const;

/**
 * The origins the Dashboard is actually served from in production.
 *
 * Better Auth checks the Origin header against this list before accepting a
 * state-changing request, so it is CSRF defence and not merely configuration:
 * an origin listed here can drive an authenticated session.
 */
const PRODUCTION_ORIGINS = [
  "https://sharednet.ai",
  "https://www.sharednet.ai",
] as const;

/**
 * Loopback origins for local development. Both spellings of both ports are
 * listed because `localhost` and `127.0.0.1` are distinct origins to a browser,
 * and `next dev` lands on 3000 or 3001 depending on what is already bound.
 *
 * These are deliberately withheld in production: trusting a developer's
 * loopback origin there would let any page they happen to be running drive a
 * live session, which is exactly the request the Origin check exists to reject.
 */
const DEVELOPMENT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
] as const;

/**
 * Resolves the origins trusted in addition to `baseURL`, whose own origin Better
 * Auth always trusts.
 *
 * `VERCEL_URL` is the deployment's own hostname, so a preview build trusts
 * itself without every preview URL having to be configured by hand.
 */
export function resolveTrustedOrigins(
  env: Record<string, string | undefined>,
): string[] {
  const origins = new Set<string>(PRODUCTION_ORIGINS);

  if (env.NODE_ENV !== "production") {
    for (const origin of DEVELOPMENT_ORIGINS) origins.add(origin);
  }

  const deploymentHost = env.VERCEL_URL?.trim();
  if (deploymentHost) origins.add(`https://${deploymentHost}`);

  for (const entry of (env.SHAREDNET_TRUSTED_ORIGINS ?? "").split(",")) {
    const origin = entry.trim();
    if (origin) origins.add(origin);
  }

  return [...origins];
}

type AuthDatabase = NonNullable<BetterAuthOptions["database"]>;

/** The MCP endpoint, which is the protected resource every access token is bound to. */
export function mcpResourceUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/api/mcp`;
}

export type CreateSharedNetAuthOptions = {
  afterUserCreated?: (user: { id: string; name: string }) => Promise<void>;
  baseURL: string;
  database: AuthDatabase;
  secret: string;
  trustedOrigins?: string[];
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for SharedNet authentication.`);
  }
  return value;
}

function hasPostgresEnvironment(): boolean {
  return POSTGRES_ENVIRONMENT_NAMES.some((name) => process.env[name]?.trim());
}

function createPostgresAdapter(): AuthDatabase {
  return drizzleAdapter(getDatabase(), {
    provider: "pg",
    schema: {
      account: authAccount,
      apikey: apiKeyTable,
      session: authSession,
      user: authUser,
      verification: authVerification,
      jwks: authJwks,
      oauthClient,
      oauthResource,
      oauthClientResource,
      oauthRefreshToken,
      oauthAccessToken,
      oauthConsent,
      oauthClientAssertion,
    },
    schemaName: "sharednet_auth",
    transaction: true,
  });
}

function resolveAuthDatabase(): AuthDatabase {
  if (hasPostgresEnvironment()) {
    return createPostgresAdapter();
  }

  throw new Error(
    "DATABASE_URL or SHAREDNET_POSTGRES_URL is required for SharedNet authentication. " +
      "SharedNet has no SQLite or in-memory fallback.",
  );
}

export function createSharedNetAuth({
  afterUserCreated,
  baseURL,
  database,
  secret,
  trustedOrigins,
}: CreateSharedNetAuthOptions) {
  return betterAuth({
    advanced: {
      database: {
        generateId: ({ model }) =>
          model === "apikey" ? generatePublicId("key") : randomUUID(),
      },
    },
    baseURL,
    database,
    databaseHooks: afterUserCreated
      ? {
          user: {
            create: {
              after: afterUserCreated,
            },
          },
        }
      : undefined,
    emailAndPassword: {
      enabled: true,
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === "/api-key/create" && context.body) {
          context.body.prefix = "snk_";
        }
      }),
    },
    trustedOrigins,
    plugins: [
      // SharedNet as an OAuth 2.1 authorization server for MCP clients:
      // ChatGPT and Claude register themselves (dynamic registration or a
      // hosted client metadata document), send the person to /login and
      // /consent once, and hold a token bound to /api/mcp. jwt signs it.
      jwt(),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: mcpResourceUrl(baseURL),
        // A client registers itself before anyone is signed in: ChatGPT and
        // Claude do this the first time a person adds SharedNet.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      apiKey({
        customKeyGenerator: () => generateSecret("snk"),
        defaultKeyLength: 43,
        defaultPrefix: "snk_",
        enableSessionForAPIKeys: false,
        rateLimit: { enabled: false },
        references: "user",
        storage: "database",
      }),
    ],
    secret,
  });
}

async function provisionPrincipalForUser(user: { id: string; name: string }) {
  try {
    await getDatabase()
      .insert(principals)
      .values({
        authUserId: user.id,
        displayName: user.name,
        id: generatePublicId("p"),
      })
      .onConflictDoNothing({ target: principals.authUserId });
  } catch {
    // Better Auth runs after-hooks after committing the account transaction.
    // Keep signup truthful and let API-key authentication perform the same
    // idempotent Principal backfill instead of stranding a committed account.
    console.error("SharedNet Principal provisioning was deferred.");
  }
}

function createRuntimeAuth() {
  const usePostgres = hasPostgresEnvironment();
  return createSharedNetAuth({
    afterUserCreated: usePostgres ? provisionPrincipalForUser : undefined,
    baseURL: requiredEnvironment("BETTER_AUTH_URL"),
    database: resolveAuthDatabase(),
    secret: requiredEnvironment("BETTER_AUTH_SECRET"),
    trustedOrigins: resolveTrustedOrigins(process.env),
  });
}

export type SharedNetAuth = ReturnType<typeof createRuntimeAuth>;

let runtimeAuth: SharedNetAuth | undefined;

/**
 * Resolve Better Auth only when a request needs it. Next.js imports route
 * modules while collecting build metadata, where runtime secrets and database
 * connections are intentionally unavailable.
 */
export function getAuth(): SharedNetAuth {
  if (!runtimeAuth) {
    runtimeAuth = createRuntimeAuth();
    // Construction starts the plugins' startup work (the OAuth provider seeds
    // its protected-resource row). If that fails, every later call fails the
    // same way and says so; the startup itself must not surface as an
    // unhandled rejection in a process that only imported the module.
    void runtimeAuth.$context.catch((error: unknown) => {
      console.error("SharedNet authentication startup failed:", error instanceof Error ? error.message : error);
    });
  }
  return runtimeAuth;
}
