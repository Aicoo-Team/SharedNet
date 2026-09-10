import { randomUUID } from "node:crypto";

import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { jwt, oAuthProxy } from "better-auth/plugins";

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
import { sendEmail } from "../src/auth/email.ts";
import { buildVerificationEmail, withCallback } from "../src/auth/verification-email.ts";

const POSTGRES_ENVIRONMENT_NAMES = [
  "DATABASE_URL",
  "SHAREDNET_POSTGRES_URL",
] as const;

/**
 * The origin SharedNet is canonically served from: the one whose Google
 * redirect URI is registered, and the one a Vercel preview borrows through
 * the OAuth proxy. See {@link resolveOAuthProxy}.
 */
const CANONICAL_ORIGIN = "https://www.sharednet.ai";

/**
 * The origins the Dashboard is actually served from in production.
 *
 * Better Auth checks the Origin header against this list before accepting a
 * state-changing request, so it is CSRF defence and not merely configuration:
 * an origin listed here can drive an authenticated session.
 */
const PRODUCTION_ORIGINS = ["https://sharednet.ai", CANONICAL_ORIGIN] as const;

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

  // The branch alias is the URL a person actually opens for a preview, while
  // VERCEL_URL is that one deployment's own hostname. Both are set by the
  // platform, so both carry the same trust; listing the alias too is what
  // lets the OAuth proxy send a preview sign-in back to the page it started
  // on rather than to the deployment URL behind it.
  const branchHost = env.VERCEL_BRANCH_URL?.trim();
  if (branchHost) origins.add(`https://${branchHost}`);

  for (const entry of (env.SHAREDNET_TRUSTED_ORIGINS ?? "").split(",")) {
    const origin = entry.trim();
    if (origin) origins.add(origin);
  }

  return [...origins];
}

export type SocialProviders = NonNullable<BetterAuthOptions["socialProviders"]>;

/**
 * Google sign-in, when this deployment has been given a client.
 *
 * Configured or absent, never half-configured: an id without a secret is the
 * shape a half-finished environment has, and offering a button that cannot
 * complete is worse than not offering one. The login page asks the same
 * question to decide whether to draw the button, so the two cannot disagree.
 */
export function resolveSocialProviders(
  env: Record<string, string | undefined>,
): SocialProviders {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return {};

  return {
    google: {
      clientId,
      clientSecret,
      // Ask which account. A person who holds a work and a personal Google
      // account is otherwise signed in as whichever one the browser is
      // already holding, with nothing on screen saying which.
      prompt: "select_account",
    },
  };
}

/**
 * Google refuses a wildcard redirect URI, and a Vercel preview's hostname is
 * different on every deployment, so a preview cannot have one registered.
 *
 * The OAuth proxy lets it borrow production's: the preview sends the person
 * to Google with production as the redirect, production hands the encrypted
 * profile straight back to the preview's own callback, and the session is
 * created on the preview. Production never creates a user or a session for a
 * preview's sign-in.
 *
 * Only on a preview. On production the two origins agree and the plugin is a
 * no-op anyway; on a laptop the origins do *not* agree, so leaving it on
 * would route local sign-ins through production — hence the environment test
 * rather than trusting the plugin's own skip.
 *
 * Both ends must derive the same encryption key, or production's reply is
 * undecryptable: either BETTER_AUTH_SECRET is identical in Production and
 * Preview, or SHAREDNET_OAUTH_PROXY_SECRET is set to the same value in both
 * — which is the better shape, because a secret shared with previews should
 * not also be the one that signs production sessions.
 */
export function resolveOAuthProxy(
  env: Record<string, string | undefined>,
): { productionURL: string; secret?: string } | null {
  if (env.VERCEL_ENV !== "preview") return null;

  const productionURL =
    env.SHAREDNET_OAUTH_PROXY_PRODUCTION_URL?.trim() || CANONICAL_ORIGIN;
  const secret = env.SHAREDNET_OAUTH_PROXY_SECRET?.trim();

  return secret ? { productionURL, secret } : { productionURL };
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
  oauthProxy?: { productionURL: string; secret?: string } | null;
  secret: string;
  socialProviders?: SocialProviders;
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
  oauthProxy,
  secret,
  socialProviders,
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
    // A person signs in with a password or with Google; both land on the same
    // Principal, because the after-hook that provisions one runs on user
    // creation whichever door was used.
    socialProviders: socialProviders ?? {},
    // An address is proven, not blocked on: a person can use SharedNet at
    // once and the mail catches up with them. Nothing here can fail a
    // sign-up, because a mail provider having a bad minute must not cost
    // somebody their account.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        const message = buildVerificationEmail({
          name: user.name,
          email: user.email,
          url: withCallback(url, `${baseURL.replace(/\/+$/, "")}/chat?verified=1`),
        });
        const outcome = await sendEmail(message);
        if (!outcome.sent && outcome.reason !== "not_configured") {
          console.error(`SharedNet could not send the verification email to ${user.email}: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`);
        }
      },
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
      // Preview deployments only, and a no-op everywhere else.
      ...(oauthProxy ? [oAuthProxy(oauthProxy)] : []),
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
    oauthProxy: resolveOAuthProxy(process.env),
    secret: requiredEnvironment("BETTER_AUTH_SECRET"),
    socialProviders: resolveSocialProviders(process.env),
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
