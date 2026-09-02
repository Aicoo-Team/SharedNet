import { chmodSync } from "node:fs";

import { betterAuth } from "better-auth";
import Database from "better-sqlite3";

const databasePath = process.env.BETTER_AUTH_DATABASE_PATH;

if (!databasePath) {
  throw new Error(
    "BETTER_AUTH_DATABASE_PATH must point to the existing SharedNet database",
  );
}

function openOwnerOnlyDatabase(path: string): Database.Database {
  const previousMask = process.umask(0o077);

  try {
    const database = new Database(path);

    if (path !== ":memory:") {
      chmodSync(/* turbopackIgnore: true */ path, 0o600);
    }

    return database;
  } finally {
    process.umask(previousMask);
  }
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  database: openOwnerOnlyDatabase(databasePath),
  emailAndPassword: {
    enabled: true,
  },
  secret: process.env.BETTER_AUTH_SECRET,
});
