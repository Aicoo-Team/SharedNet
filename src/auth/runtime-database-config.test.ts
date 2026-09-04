// @vitest-environment node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const secret = "runtime-config-test-secret-with-at-least-thirty-two-characters";

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "SHAREDNET_POSTGRES_URL",
    "SHAREDNET_POSTGRES_URL_NON_POOLING",
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

  it("refuses to start without a Postgres URL, with no fallback of any kind", () => {
    const result = importAuth(isolatedEnvironment());
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(output).toContain("DATABASE_URL or SHAREDNET_POSTGRES_URL is required");
    expect(output).toContain("no SQLite or in-memory fallback");
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
