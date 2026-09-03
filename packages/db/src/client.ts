import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { attachDatabasePool } from "@vercel/functions";

import { authSchema } from "./auth-schema.ts";
import { databaseSchema } from "./schema.ts";

const schema = { ...authSchema, ...databaseSchema };

export type SharedNetDatabase = NodePgDatabase<typeof schema>;

let runtimePool: Pool | undefined;
let runtimeDatabase: SharedNetDatabase | undefined;

type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;

function validatePostgresUrl(value: string | undefined, environmentName: string): string {
  const candidate = value?.trim();
  if (!candidate) {
    throw new Error(`${environmentName} is required; SharedNet will not fall back to an in-memory database.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${environmentName} must be a valid PostgreSQL connection URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${environmentName} must use the postgres:// or postgresql:// scheme.`);
  }
  return candidate;
}

export function getRuntimeDatabaseUrl(
  environment: DatabaseEnvironment = process.env,
): string {
  return validatePostgresUrl(
    environment.DATABASE_URL?.trim() || environment.SHAREDNET_POSTGRES_URL?.trim(),
    "DATABASE_URL (or SHAREDNET_POSTGRES_URL)",
  );
}

export function getMigrationDatabaseUrl(
  environment: DatabaseEnvironment = process.env,
): string {
  return validatePostgresUrl(
    environment.DATABASE_URL_UNPOOLED?.trim() ||
      environment.SHAREDNET_POSTGRES_URL_NON_POOLING?.trim(),
    "DATABASE_URL_UNPOOLED (or SHAREDNET_POSTGRES_URL_NON_POOLING)",
  );
}

export function createDatabase(pool: Pool): SharedNetDatabase {
  return drizzle(pool, { schema });
}

export function createDatabasePool(config: PoolConfig = {}): Pool {
  const connectionString =
    config.connectionString === undefined
      ? getRuntimeDatabaseUrl()
      : getRuntimeDatabaseUrl({ DATABASE_URL: config.connectionString });
  const pool = new Pool({
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...config,
    connectionString,
  });
  attachDatabasePool(pool);
  return pool;
}

/** One lazy, module-scoped pool for all runtime requests in this process. */
export function getDatabasePool(): Pool {
  runtimePool ??= createDatabasePool();
  return runtimePool;
}

export function getDatabase(): SharedNetDatabase {
  runtimeDatabase ??= createDatabase(getDatabasePool());
  return runtimeDatabase;
}

/** Test/dev shutdown hook; application request paths should never call this. */
export async function closeDatabase(): Promise<void> {
  const pool = runtimePool;
  runtimeDatabase = undefined;
  runtimePool = undefined;
  if (pool) await pool.end();
}
