import { randomUUID } from "node:crypto";

import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import {
  apiKey as apiKeyTable,
  authAccount,
  authSession,
  authUser,
  authVerification,
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

type AuthDatabase = NonNullable<BetterAuthOptions["database"]>;

export type CreateSharedNetAuthOptions = {
  afterUserCreated?: (user: { id: string; name: string }) => Promise<void>;
  baseURL: string;
  database: AuthDatabase;
  secret: string;
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
    plugins: [
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
  runtimeAuth ??= createRuntimeAuth();
  return runtimeAuth;
}
