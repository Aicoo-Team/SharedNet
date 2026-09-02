// @vitest-environment node

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const secret = "migration-test-secret-with-at-least-thirty-two-characters";
const temporaryDirectories: string[] = [];

function createDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), "sharednet-auth-migrate-"));
  temporaryDirectories.push(directory);
  return join(directory, "auth.sqlite");
}

function migrationEnvironment(databasePath: string) {
  const environment = { ...process.env };
  delete environment.BETTER_AUTH_DATABASE_PATH;
  delete environment.BETTER_AUTH_SECRET;
  delete environment.BETTER_AUTH_URL;

  return {
    ...environment,
    BETTER_AUTH_DATABASE_PATH: databasePath,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: "http://127.0.0.1:3001",
  };
}

function runMigration(environment: NodeJS.ProcessEnv) {
  return spawnSync("pnpm", ["run", "auth:migrate"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment,
    timeout: 30_000,
  });
}

function commandOutput(result: ReturnType<typeof runMigration>) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Better Auth migration command", () => {
  it(
    "creates an owner-only fresh schema, remains repeatable, and prints no secret",
    () => {
      const databasePath = createDatabasePath();
      const environment = migrationEnvironment(databasePath);

      const firstRun = runMigration(environment);
      const secondRun = runMigration(environment);

      expect(firstRun.error).toBeUndefined();
      expect(firstRun.status, commandOutput(firstRun)).toBe(0);
      expect(secondRun.error).toBeUndefined();
      expect(secondRun.status, commandOutput(secondRun)).toBe(0);
      expect(commandOutput(firstRun)).not.toContain(secret);
      expect(commandOutput(secondRun)).not.toContain(secret);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);

      const database = new Database(databasePath, { readonly: true });
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      database.close();

      expect(tables).toEqual(["account", "session", "user", "verification"]);
    },
    30_000,
  );

  it.each([
    "BETTER_AUTH_DATABASE_PATH",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
  ] as const)("fails closed when %s is missing", (missingVariable) => {
    const databasePath = createDatabasePath();
    const environment = migrationEnvironment(databasePath);
    delete environment[missingVariable];

    const result = runMigration(environment);
    const output = commandOutput(result);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(output).toContain(missingVariable);
    expect(output).not.toContain(secret);
    expect(existsSync(databasePath)).toBe(false);
  });
});
