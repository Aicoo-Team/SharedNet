// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryDirectories: string[] = [];
const secret = "runtime-config-test-secret-with-at-least-thirty-two-characters";

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "SHAREDNET_POSTGRES_URL",
    "SHAREDNET_POSTGRES_URL_NON_POOLING",
    "BETTER_AUTH_DATABASE_PATH",
  ]) {
    delete environment[name];
  }
  return {
    ...environment,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: "http://127.0.0.1:3001",
    NODE_ENV: "production",
  };
}

function importAuth(environment: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      "const { getAuth } = await import('./lib/auth.ts'); getAuth(); const { closeDatabase } = await import('./packages/db/src/client.ts'); await closeDatabase();",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Better Auth runtime database selection", () => {
  it("can be imported during a production build without runtime configuration", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        "await import('./lib/auth.ts');",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: isolatedEnvironment(),
        timeout: 30_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
  });

  it("rejects the SQLite compatibility path in production", () => {
    const directory = mkdtempSync(join(tmpdir(), "sharednet-auth-config-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "must-not-be-created.sqlite");
    const result = importAuth({
      ...isolatedEnvironment(),
      BETTER_AUTH_DATABASE_PATH: databasePath,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(output).toContain("DATABASE_URL or SHAREDNET_POSTGRES_URL is required");
    expect(existsSync(databasePath)).toBe(false);
  });

  it.each(["DATABASE_URL", "SHAREDNET_POSTGRES_URL"] as const)(
    "selects Postgres when %s is present",
    (environmentName) => {
      const result = importAuth({
        ...isolatedEnvironment(),
        [environmentName]: "postgres://sharednet:local-test@127.0.0.1:1/sharednet",
      });

      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
    },
  );
});
