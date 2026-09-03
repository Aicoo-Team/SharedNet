import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

import { getMigrationDatabaseUrl } from "./client.ts";

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));
const MIGRATION_LOCK_NAME = "sharednet:v1:drizzle-migrations";

export type MigrateDatabaseOptions = {
  connectionString?: string;
  migrationsFolder?: string;
};

/** Runs reviewed migrations on a dedicated, unpooled session under an advisory lock. */
export async function migrateDatabase(options: MigrateDatabaseOptions = {}): Promise<void> {
  const connectionString =
    options.connectionString === undefined
      ? getMigrationDatabaseUrl()
      : getMigrationDatabaseUrl({ DATABASE_URL_UNPOOLED: options.connectionString });
  const client = new Client({ connectionString });
  let lockAcquired = false;

  try {
    await client.connect();
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '5min'");
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
    lockAcquired = true;

    await migrate(drizzle(client), {
      migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
      migrationsSchema: "sharednet_migrations",
      migrationsTable: "drizzle_migrations",
    });
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
      }
    } finally {
      await client.end();
    }
  }
}
