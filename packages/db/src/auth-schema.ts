import {
  boolean,
  check,
  index,
  integer,
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

/** Better Auth 1.7.2 core `account` model. */
export const authAccount = sharednetAuthSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    issuer: text("issuer").notNull(),
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
    check("auth_apikey_id_format", sql`${table.id} ~ '^key_[0-9a-hjkmnp-tv-z]{26}$'`),
  ],
);

/** Adapter keys must exactly match Better Auth's model names. */
export const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  apikey: apiKey,
} as const;
