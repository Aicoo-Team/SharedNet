import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { authSchema } from "./auth-schema.ts";
import {
  createDatabasePool,
  getMigrationDatabaseUrl,
  getRuntimeDatabaseUrl,
} from "./client.ts";
import {
  agents,
  databaseSchema,
  roomGuests,
  roomInvites,
  decisions,
  idempotencyRecords,
  instances,
  messages,
  roomMembers,
  rooms,
} from "./schema.ts";

describe("hosted Postgres schema", () => {
  it("exports the generated-compatible Better Auth model names", () => {
    expect(Object.keys(authSchema)).toEqual([
      "user",
      "session",
      "account",
      "verification",
      "apikey",
      // jwt plugin: signing keys for the tokens the OAuth provider issues.
      "jwks",
      // OAuth provider (mcp plugin): clients, the protected resource, grants and tokens.
      "oauthClient",
      "oauthResource",
      "oauthClientResource",
      "oauthRefreshToken",
      "oauthAccessToken",
      "oauthConsent",
      "oauthClientAssertion",
    ]);
  });

  it("exports exactly the twelve V1 domain tables, the four credit tables and the two artifact tables", () => {
    expect(Object.keys(databaseSchema)).toEqual([
      "principals",
      "agents",
      "instances",
      "rooms",
      "roomMembers",
      "roomInvites",
      "roomGuests",
      "messages",
      "decisions",
      "idempotencyRecords",
      "cliLogins",
      "instanceCursors",
      "creditAccounts",
      "creditCodes",
      "creditTransfers",
      "creditRedemptions",
      "artifacts",
      "artifactBytes",
      "instanceAliases",
      "userAvatars",
    ]);
  });

  it("stores only digests of Room invite and member tokens, and one sender per message", () => {
    expect(getTableColumns(roomInvites)).toHaveProperty("tokenDigest");
    expect(getTableColumns(roomInvites)).not.toHaveProperty("token");
    expect(getTableColumns(roomGuests)).toHaveProperty("tokenDigest");
    expect(getTableColumns(roomGuests)).not.toHaveProperty("token");
    const messageColumns = getTableColumns(messages);
    expect(messageColumns.senderInstanceId.notNull).toBe(false);
    expect(messageColumns.senderGuestId.notNull).toBe(false);
  });

  it("stores only an Instance token digest", () => {
    const columns = getTableColumns(instances);
    expect(columns).toHaveProperty("tokenDigest");
    expect(columns).not.toHaveProperty("token");
    expect(columns).not.toHaveProperty("instanceToken");
  });

  it("stores who acted, never a copy of how they were grouped", () => {
    // The Instance is the immutable fact; its tag is derived at read time from
    // instance.agent_id, the single place a grouping lives. A stored copy would
    // have to be rewritten on every regroup, or silently disagree.
    const messageColumns = getTableColumns(messages);
    expect(Object.keys(messageColumns)).toEqual(
      expect.arrayContaining(["senderPrincipalId", "senderInstanceId", "replyToMessageId"]),
    );
    expect(messageColumns).not.toHaveProperty("senderAgentId");
    expect(getTableColumns(roomMembers)).not.toHaveProperty("agentId");
    expect(getTableColumns(rooms)).not.toHaveProperty("creatorAgentId");
    expect(getTableColumns(decisions)).not.toHaveProperty("requestedByAgentId");
  });

  it("makes the tag pointer optional and the session key a dedupe key", () => {
    const columns = getTableColumns(instances);
    expect(columns.agentId.notNull).toBe(false);
    expect(columns).toHaveProperty("localInstanceKey");
    expect(columns.localInstanceKey.notNull).toBe(false);
  });

  it("keeps idempotency scope in physical columns", () => {
    expect(Object.keys(getTableColumns(idempotencyRecords))).toEqual(
      expect.arrayContaining([
        "principalId",
        "credentialClass",
        "actorId",
        "operationId",
        "idempotencyKey",
        "expiresAt",
      ]),
    );
    // There is no default Agent: an untagged Instance has a null pointer.
    expect(getTableColumns(agents)).not.toHaveProperty("isDefault");
  });

  it("resolves canonical and supplied Supabase environment aliases without fallback", () => {
    expect(
      getRuntimeDatabaseUrl({ DATABASE_URL: "postgresql://runtime/db" }),
    ).toBe("postgresql://runtime/db");
    expect(
      getRuntimeDatabaseUrl({ SHAREDNET_POSTGRES_URL: "postgres://supabase/db" }),
    ).toBe("postgres://supabase/db");
    expect(
      getMigrationDatabaseUrl({
        SHAREDNET_POSTGRES_URL_NON_POOLING: "postgresql://direct/db",
      }),
    ).toBe("postgresql://direct/db");
    expect(() => getRuntimeDatabaseUrl({})).toThrow(/DATABASE_URL/);
    expect(() => getMigrationDatabaseUrl({})).toThrow(/DATABASE_URL_UNPOOLED/);
    expect(() => createDatabasePool({ connectionString: "" })).toThrow(/DATABASE_URL/);
  });

  it("checks in an executable migration with the required database constraints", () => {
    const migrationsDirectory = join(process.cwd(), "packages/db/migrations");
    const migrationNames = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrationNames.length).toBeGreaterThan(0);
    const migration = migrationNames
      .map((name) => readFileSync(`${migrationsDirectory}/${name}`, "utf8"))
      .join("\n");

    expect(migration).toContain('CREATE SCHEMA "sharednet_auth"');
    expect(migration).toContain('CREATE SCHEMA "sharednet"');
    expect(migration).toContain('CONSTRAINT "auth_apikey_key_unique" UNIQUE("key")');
    expect(migration).toContain('CONSTRAINT "apikey_reference_id_user_id_fk"');
    expect(migration).toContain('CREATE UNIQUE INDEX "agent_one_default_per_principal"');
    expect(migration).toContain('CONSTRAINT "message_same_room_reply_fk"');
    expect(migration).toContain('CONSTRAINT "decision_state_consistent"');
    expect(migration).toContain('CONSTRAINT "room_share_consistent"');
    expect(migration).toContain('CONSTRAINT "credit_account_balance_nonnegative"');
    expect(migration).toContain('CONSTRAINT "credit_transfer_minted_or_paid"');
    expect(migration).toContain('CONSTRAINT "credit_redemption_pk" PRIMARY KEY("code","principal_id")');
    expect(migration).toContain('CONSTRAINT "artifact_filename_is_a_name"');
    expect(migration).toContain('CONSTRAINT "user_avatar_content_type_known"');
    // One kind of file: every artifact has a link, and `reach` is gone.
    expect(migration).toContain('ALTER COLUMN "link_key" SET NOT NULL');
    expect(migration).toContain('DROP COLUMN "reach"');
    expect(migration).toContain('CONSTRAINT "instance_alias_pk" PRIMARY KEY("principal_id","instance_id")');
    expect(migration).toContain('CONSTRAINT "idempotency_retention_minimum"');
    expect(migration).toContain(
      'DROP CONSTRAINT "instance_issued_by_key_fk"',
    );
    expect(migration).toContain(
      'CONSTRAINT "instance_issued_by_key_id_format"',
    );
    expect(migration).not.toMatch(/\$\d+/);
    expect(migration).not.toContain('CREATE TABLE "public"');
    expect(migration).not.toContain('CREATE TABLE "auth"');
  });
});
