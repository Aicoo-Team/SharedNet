import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const sharednetAuthSchema = pgSchema("sharednet_auth");

const authTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

/** Better Auth 1.7.2 core `user` model. */
export const authUser = sharednetAuthSchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [unique("auth_user_email_unique").on(table.email)],
);

/** Better Auth 1.7.2 core `session` model. */
export const authSession = sharednetAuthSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: authTimestamp("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("auth_session_token_unique").on(table.token),
    index("auth_session_user_id_idx").on(table.userId),
  ],
);

/**
 * Better Auth core `account` model. `issuer` was part of it up to 1.7.2 and
 * left the model in 1.7.3, so the column stays for the rows that carry one
 * and is nullable for the rows Better Auth writes now; uniqueness of a
 * provider account is the library's own affair, as its generated schema shows.
 */
export const authAccount = sharednetAuthSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    issuer: text("issuer"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: authTimestamp("access_token_expires_at"),
    refreshTokenExpiresAt: authTimestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("auth_account_issuer_account_id_unique").on(table.issuer, table.accountId),
    index("auth_account_user_id_idx").on(table.userId),
  ],
);

/** Better Auth 1.7.2 core `verification` model. */
export const authVerification = sharednetAuthSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: authTimestamp("expires_at").notNull(),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("auth_verification_identifier_idx").on(table.identifier)],
);

/** Better Auth 1.7.2 API-key plugin `apikey` model. */
export const apiKey = sharednetAuthSchema.table(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: authTimestamp("last_refill_at"),
    enabled: boolean("enabled").default(true).notNull(),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true).notNull(),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86_400_000).notNull(),
    rateLimitMax: integer("rate_limit_max").default(10).notNull(),
    requestCount: integer("request_count").default(0).notNull(),
    remaining: integer("remaining"),
    lastRequest: authTimestamp("last_request"),
    expiresAt: authTimestamp("expires_at"),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    unique("auth_apikey_key_unique").on(table.key),
    index("auth_apikey_config_id_idx").on(table.configId),
    index("auth_apikey_reference_id_idx").on(table.referenceId),
    check("auth_apikey_id_format", sql`${table.id} ~ '^key_[0-9A-Za-z]{10}$'`),
  ],
);

/** Adapter keys must exactly match Better Auth's model names. */
/**
 * Better Auth `jwt` plugin: the signing keys behind the access and ID tokens
 * the OAuth provider issues to MCP clients (ChatGPT, Claude). Private keys are
 * encrypted by Better Auth before they reach this table.
 */
export const authJwks = sharednetAuthSchema.table("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: authTimestamp("created_at").notNull(),
  expiresAt: authTimestamp("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});

/**
 * Better Auth OAuth provider (`@better-auth/mcp`): SharedNet as an OAuth 2.1
 * authorization server for MCP clients. One row per client that registered
 * (ChatGPT, Claude, a developer's own), per resource we protect (`/api/mcp`),
 * per grant a user gave, and per token issued. Tokens are stored hashed.
 */
export const oauthClient = sharednetAuthSchema.table(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes").array().default(sql`'{}'::text[]`),
    userId: text("user_id").references(() => authUser.id, { onDelete: "cascade" }),
    createdAt: authTimestamp("created_at"),
    updatedAt: authTimestamp("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (table) => [unique("oauth_client_client_id_unique").on(table.clientId), index("oauth_client_user_idx").on(table.userId)],
);

export const oauthResource = sharednetAuthSchema.table(
  "oauth_resource",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    accessTokenTtl: integer("access_token_ttl"),
    refreshTokenTtl: integer("refresh_token_ttl"),
    signingAlgorithm: text("signing_algorithm"),
    signingKeyId: text("signing_key_id"),
    allowedScopes: text("allowed_scopes").array(),
    customClaims: jsonb("custom_claims"),
    dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
    disabled: boolean("disabled").default(false),
    createdAt: authTimestamp("created_at"),
    updatedAt: authTimestamp("updated_at"),
    policyVersion: integer("policy_version").default(1),
    metadata: jsonb("metadata"),
  },
  (table) => [unique("oauth_resource_identifier_unique").on(table.identifier)],
);

export const oauthClientResource = sharednetAuthSchema.table(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: authTimestamp("created_at"),
  },
  (table) => [index("oauth_client_resource_client_idx").on(table.clientId)],
);

export const oauthRefreshToken = sharednetAuthSchema.table(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("session_id").references(() => authSession.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: authTimestamp("expires_at").notNull(),
    createdAt: authTimestamp("created_at").notNull(),
    revoked: authTimestamp("revoked"),
    rotatedAt: authTimestamp("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: authTimestamp("rotation_replay_expires_at"),
    authTime: authTimestamp("auth_time"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [unique("oauth_refresh_token_token_unique").on(table.token), index("oauth_refresh_token_user_idx").on(table.userId)],
);

export const oauthAccessToken = sharednetAuthSchema.table(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("session_id").references(() => authSession.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => authUser.id),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id),
    expiresAt: authTimestamp("expires_at").notNull(),
    createdAt: authTimestamp("created_at").notNull(),
    revoked: authTimestamp("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [unique("oauth_access_token_token_unique").on(table.token), index("oauth_access_token_user_idx").on(table.userId)],
);

export const oauthConsent = sharednetAuthSchema.table(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    userId: text("user_id").references(() => authUser.id),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: authTimestamp("created_at").notNull(),
    updatedAt: authTimestamp("updated_at").notNull(),
  },
  (table) => [index("oauth_consent_user_idx").on(table.userId), index("oauth_consent_client_idx").on(table.clientId)],
);

export const oauthClientAssertion = sharednetAuthSchema.table("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: authTimestamp("expires_at").notNull(),
});

export const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  apikey: apiKey,
  jwks: authJwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
} as const;
