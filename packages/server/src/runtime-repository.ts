import {
  createDatabase,
  createDatabasePool,
  getDatabase,
} from "../../db/src/index.ts";
import { MemorySharedNetRepository } from "./memory-repository.ts";
import { PostgresSharedNetRepository } from "./postgres-repository.ts";
import { RepositoryError, type SharedNetRepository } from "./repository.ts";

function databaseUrl(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.DATABASE_URL?.trim() || environment.SHAREDNET_POSTGRES_URL?.trim();
}

/**
 * Builds the repository used by Next and the standalone server.
 *
 * MemorySharedNetRepository is deliberately not an implicit fallback: a missing
 * hosted database must fail closed instead of accepting writes that disappear
 * on the next process restart.
 */
export function createRuntimeRepository(
  environment: NodeJS.ProcessEnv = process.env,
): SharedNetRepository {
  if (environment.NODE_ENV === "test" && environment.SHAREDNET_DEV_API_KEY) {
    return new MemorySharedNetRepository({
      devApiKey: environment.SHAREDNET_DEV_API_KEY,
    });
  }

  const url = databaseUrl(environment);
  if (!url) {
    throw new RepositoryError(
      503,
      "service_unavailable",
      "SharedNet database is not configured.",
    );
  }
  const database =
    environment === process.env
      ? getDatabase()
      : createDatabase(createDatabasePool({ connectionString: url }));
  return new PostgresSharedNetRepository(database);
}
