// @vitest-environment node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationScript = fileURLToPath(
  new URL("../../scripts/migrate-auth.mjs", import.meta.url),
);

function migrationEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.DATABASE_URL_UNPOOLED;
  delete environment.SHAREDNET_POSTGRES_URL_NON_POOLING;

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

function runMigration(environment: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", migrationScript],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    },
  );
}

function commandOutput(result: ReturnType<typeof runMigration>) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

describe("SharedNet migration command", () => {
  it("fails closed before connecting when no unpooled migration URL is set", () => {
    const result = runMigration(migrationEnvironment());
    const output = commandOutput(result);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(output).toContain("DATABASE_URL_UNPOOLED");
    expect(output).toContain("SHAREDNET_POSTGRES_URL_NON_POOLING");
  });

  it("never prints a rejected connection URL or its password", () => {
    const password = "migration-test-password-that-must-not-be-printed";
    const connectionString = `postgres://sharednet:${password}@127.0.0.1:1/sharednet`;
    const result = runMigration(
      migrationEnvironment({ DATABASE_URL_UNPOOLED: connectionString }),
    );
    const output = commandOutput(result);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(output).toContain("SharedNet database migration failed.");
    expect(output).not.toContain(connectionString);
    expect(output).not.toContain(password);
  });

  it("uses the checked Drizzle pipeline instead of runtime Better Auth migrations", () => {
    const source = readFileSync(migrationScript, "utf8");

    expect(source).toContain("migrateDatabase");
    expect(source).not.toContain("getMigrations");
    expect(source).not.toContain("BETTER_AUTH_DATABASE_PATH");
  });
});
