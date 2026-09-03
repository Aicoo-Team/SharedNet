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
  idempotencyRecords,
  instances,
  messages,
} from "./schema.ts";

describe("hosted Postgres schema", () => {
  it("exports the generated-compatible Better Auth model names", () => {
    expect(Object.keys(authSchema)).toEqual([
      "user",
      "session",
      "account",
      "verification",
      "apikey",
    ]);
  });

  it("exports exactly the eight V1 domain tables", () => {
    expect(Object.keys(databaseSchema)).toEqual([
      "principals",
      "agents",
      "instances",
      "rooms",
      "roomMembers",
      "messages",
      "decisions",
      "idempotencyRecords",
    ]);
  });

  it("stores only an Instance token digest", () => {
    const columns = getTableColumns(instances);
    expect(columns).toHaveProperty("tokenDigest");
    expect(columns).not.toHaveProperty("token");
    expect(columns).not.toHaveProperty("instanceToken");
  });

  it("keeps provenance and idempotency scope in physical columns", () => {
    expect(Object.keys(getTableColumns(messages))).toEqual(
      expect.arrayContaining([
        "senderPrincipalId",
        "senderAgentId",
        "senderInstanceId",
        "replyToMessageId",
      ]),
    );
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
    expect(getTableColumns(agents)).toHaveProperty("isDefault");
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
