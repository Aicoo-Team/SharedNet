// @vitest-environment node

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DemoSeedError,
  SqliteAuthUserLookup,
  parseDemoSeedArgs,
  readDemoSeedEnvironment,
  seedDemoAccount,
  type AuthUserLookup,
  type DemoSeedFetch,
  type DemoSeedResult,
  type SeedDemoAccountOptions,
} from "./demo-seed";

const temporaryDirectories: string[] = [];
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

const validSeedResult: DemoSeedResult = {
  connected_agent_ids: ["a_F6g7H8i9J0", "a_K1l2M3n4O5"],
  connected_principal_id: "p_F6g7H8i9J0",
  counts: {
    connected_agents: 2,
    owner_agents: 1,
    principal_connections: 1,
  },
  owner_agent_ids: ["a_A1b2C3d4E5"],
  principal_id: "p_A1b2C3d4E5",
};

function successfulOptions(fetch: DemoSeedFetch): SeedDemoAccountOptions {
  return {
    apiUrl: "https://api.sharednet.test",
    consoleToken: "console-test-token",
    email: "xisen.demo@sharednet.local",
    fetch,
    lookup: {
      close() {},
      findUserIdsByEmail() {
        return ["auth-user-id"];
      },
    },
  };
}

function createAuthDatabase(
  users: ReadonlyArray<{ email: string; id: string }>,
): string {
  const directory = mkdtempSync(join(tmpdir(), "sharednet-demo-seed-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "auth.sqlite");
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE "user" (
        id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        emailVerified INTEGER NOT NULL,
        image TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    const insert = database.prepare(`
      INSERT INTO "user"(
        id, name, email, emailVerified, image, createdAt, updatedAt
      ) VALUES (?, ?, ?, 1, NULL, 1, 1)
    `);
    for (const user of users) {
      insert.run(user.id, "Demo User", user.email);
    }
  } finally {
    database.close();
  }

  return databasePath;
}

function commandEnvironment(
  values: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "",
    ...values,
  };
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: projectRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("demo seed command timed out"));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stderr, stdout });
    });
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("demo seed command", () => {
  it("parses and normalizes exactly one --email argument", () => {
    expect(
      parseDemoSeedArgs([
        "--email",
        "  Xisen.Demo@SharedNet.Local  ",
      ]),
    ).toEqual({ email: "xisen.demo@sharednet.local" });
  });

  it.each([
    { arguments_: [], caseName: "missing option" },
    { arguments_: ["--email"], caseName: "missing value" },
    {
      arguments_: ["email", "xisen.demo@sharednet.local"],
      caseName: "wrong option",
    },
    { arguments_: ["--email", ""], caseName: "empty value" },
    { arguments_: ["--email", "not-an-email"], caseName: "malformed value" },
    {
      arguments_: ["--email", "first@example.com", "extra"],
      caseName: "extra argument",
    },
    {
      arguments_: [
        "--email",
        "first@example.com",
        "--email",
        "second@example.com",
      ],
      caseName: "duplicate option",
    },
  ])("rejects an invalid email argument: $caseName", ({ arguments_ }) => {
    expect(() => parseDemoSeedArgs(arguments_)).toThrow(
      "Use --email with one valid email address.",
    );
  });

  it.each([
    { caseName: "no account", userIds: [] },
    { caseName: "multiple accounts", userIds: ["user-one", "user-two"] },
  ])(
    "requires exactly one normalized email match: $caseName",
    async ({ userIds }) => {
      const lookup: AuthUserLookup = {
        close() {},
        findUserIdsByEmail() {
          return userIds;
        },
      };

      await expect(
        seedDemoAccount({
          apiUrl: "https://api.sharednet.test",
          consoleToken: "console-test-token",
          email: "xisen.demo@sharednet.local",
          fetch: async () => {
            throw new Error("HTTP must not run for an ambiguous lookup");
          },
          lookup,
        }),
      ).rejects.toThrow(
        "Expected exactly one Better Auth user for the requested email.",
      );
    },
  );

  it.each([
    "ftp://api.sharednet.test",
    "https://user:password@api.sharednet.test",
    "https://api.sharednet.test/v1",
    "https://api.sharednet.test?debug=true",
    "https://api.sharednet.test?",
    "https://api.sharednet.test#fragment",
    "https://api.sharednet.test#",
    " https://api.sharednet.test ",
    "not a URL",
  ])("rejects a non-origin API URL without echoing it: %s", async (apiUrl) => {
    await expect(
      seedDemoAccount({
        apiUrl,
        consoleToken: "console-test-token",
        email: "xisen.demo@sharednet.local",
        fetch: async () => {
          throw new Error("HTTP must not run for an invalid origin");
        },
        lookup: {
          close() {},
          findUserIdsByEmail() {
            return ["auth-user-id"];
          },
        },
      }),
    ).rejects.toThrow(
      "SHAREDNET_API_URL must be a credential-free HTTP(S) origin.",
    );
  });

  it.each([
    { caseName: "blank ID", userIds: ["   "] },
    { caseName: "non-string ID", userIds: [42] },
  ])(
    "rejects a malformed single lookup row: $caseName",
    async ({ userIds }) => {
      await expect(
        seedDemoAccount({
          ...successfulOptions(async () => Response.json(validSeedResult)),
          lookup: {
            close() {},
            findUserIdsByEmail() {
              return userIds as unknown as readonly string[];
            },
          },
        }),
      ).rejects.toThrow(
        "Expected exactly one Better Auth user for the requested email.",
      );
    },
  );

  it.each([".", ".."])(
    "rejects an auth-user ID normalized out of the endpoint before fetch: %s",
    async (userId) => {
      const fetch = vi.fn(async () => Response.json(validSeedResult));

      await expect(
        seedDemoAccount({
          ...successfulOptions(fetch),
          lookup: {
            close() {},
            findUserIdsByEmail() {
              return [userId];
            },
          },
        }),
      ).rejects.toEqual(
        new DemoSeedError(
          "Expected exactly one Better Auth user for the requested email.",
        ),
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("posts to the exact encoded account endpoint with the Console header", async () => {
    const consoleToken = "console-test-token";
    let capturedRequest: Request | undefined;

    const result = await seedDemoAccount({
      apiUrl: "https://api.sharednet.test:8443/",
      consoleToken,
      email: "  Xisen.Demo@SharedNet.Local ",
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        return Response.json(validSeedResult);
      },
      lookup: {
        close() {},
        findUserIdsByEmail(normalizedEmail) {
          return normalizedEmail === "xisen.demo@sharednet.local"
            ? ["auth/user?# id"]
            : [];
        },
      },
    });

    expect(result).toEqual(validSeedResult);
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.url).toBe(
      "https://api.sharednet.test:8443/v1/console/accounts/auth%2Fuser%3F%23%20id/demo-seed",
    );
    expect(capturedRequest!.method).toBe("POST");
    expect(capturedRequest!.headers.get("x-sharednet-console-token")).toBe(
      consoleToken,
    );
  });

  it("uses manual redirect handling and refuses redirect responses", async () => {
    let redirectMode: RequestRedirect | undefined;

    const result = seedDemoAccount({
      apiUrl: "http://127.0.0.1:8765",
      consoleToken: "console-test-token",
      email: "xisen.demo@sharednet.local",
      fetch: async (_input, init) => {
        redirectMode = init?.redirect;
        return new Response(null, {
          headers: { location: "https://elsewhere.test/private" },
          status: 302,
        });
      },
      lookup: {
        close() {},
        findUserIdsByEmail() {
          return ["auth-user-id"];
        },
      },
    });

    await expect(result).rejects.toThrow(
      "SharedNet demo seed request failed.",
    );
    expect(redirectMode).toBe("manual");
  });

  it.each([400, 401, 500])(
    "rejects HTTP %s without exposing the response body",
    async (status) => {
      const rawBody = "private upstream error body";
      let caught: unknown;

      try {
        await seedDemoAccount({
          apiUrl: "https://api.sharednet.test",
          consoleToken: "console-test-token",
          email: "xisen.demo@sharednet.local",
          fetch: async () =>
            Response.json({ error: rawBody }, { status }),
          lookup: {
            close() {},
            findUserIdsByEmail() {
              return ["auth-user-id"];
            },
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toEqual(
        new DemoSeedError("SharedNet demo seed request failed."),
      );
      expect(String(caught)).not.toContain(rawBody);
    },
  );

  it.each([
    { body: null, caseName: "null body" },
    { body: [], caseName: "array body" },
    {
      body: { ...validSeedResult, principal_id: "principal-internal" },
      caseName: "untyped Principal ID",
    },
    {
      body: { ...validSeedResult, owner_agent_ids: ["agent-internal"] },
      caseName: "untyped Agent ID",
    },
    {
      body: { ...validSeedResult, connected_agent_ids: "a_F6g7H8i9J0" },
      caseName: "non-array Agent IDs",
    },
    {
      body: {
        ...validSeedResult,
        counts: { ...validSeedResult.counts, owner_agents: -1 },
      },
      caseName: "negative count",
    },
    {
      body: {
        ...validSeedResult,
        counts: { ...validSeedResult.counts, connected_agents: 1.5 },
      },
      caseName: "fractional count",
    },
    {
      body: {
        ...validSeedResult,
        counts: {
          ...validSeedResult.counts,
          principal_connections: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      caseName: "integer count outside the safe range",
    },
    {
      body: {
        ...validSeedResult,
        counts: { ...validSeedResult.counts, owner_agents: 2 },
      },
      caseName: "count that disagrees with returned IDs",
    },
    {
      body: { ...validSeedResult, private_seed_key: "must-not-escape" },
      caseName: "unexpected top-level field",
    },
    {
      body: {
        ...validSeedResult,
        counts: { ...validSeedResult.counts, global_rows: 99 },
      },
      caseName: "unexpected count field",
    },
  ])("rejects an unsafe seed response: $caseName", async ({ body }) => {
    await expect(
      seedDemoAccount(
        successfulOptions(async () => Response.json(body)),
      ),
    ).rejects.toThrow("SharedNet demo seed response was invalid.");
  });

  it("sanitizes malformed response-body errors", async () => {
    const rawBody = "raw private upstream body";
    let caught: unknown;

    try {
      await seedDemoAccount(
        successfulOptions(
          async () =>
            new Response(rawBody, {
              headers: { "content-type": "application/json" },
              status: 200,
            }),
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(
      new DemoSeedError(
        "SharedNet demo seed response was invalid.",
      ),
    );
    expect(String(caught)).not.toContain(rawBody);
  });

  it("rejects a response reported as redirected even when its status is 200", async () => {
    const response = Response.json(validSeedResult);
    Object.defineProperty(response, "redirected", { value: true });

    await expect(
      seedDemoAccount(successfulOptions(async () => response)),
    ).rejects.toThrow("SharedNet demo seed request failed.");
  });

  it("reads only the three required seed environment values", () => {
    expect(
      readDemoSeedEnvironment({
        BETTER_AUTH_DATABASE_PATH: "/temporary/auth.sqlite",
        SHAREDNET_API_URL: "http://127.0.0.1:8000",
        SHAREDNET_CONSOLE_TOKEN: "console-test-token",
        UNRELATED_SECRET: "do-not-return",
      }),
    ).toEqual({
      apiUrl: "http://127.0.0.1:8000",
      consoleToken: "console-test-token",
      databasePath: "/temporary/auth.sqlite",
    });
  });

  it.each([
    "BETTER_AUTH_DATABASE_PATH",
    "SHAREDNET_API_URL",
    "SHAREDNET_CONSOLE_TOKEN",
  ])("fails closed when %s is missing or blank", (missingName) => {
    const environment: NodeJS.ProcessEnv = {
      BETTER_AUTH_DATABASE_PATH: "/temporary/auth.sqlite",
      NODE_ENV: "test",
      SHAREDNET_API_URL: "http://127.0.0.1:8000",
      SHAREDNET_CONSOLE_TOKEN: "console-test-token",
    };
    environment[missingName] = "   ";

    expect(() => readDemoSeedEnvironment(environment)).toThrow(
      "Demo seed requires BETTER_AUTH_DATABASE_PATH, SHAREDNET_API_URL, and SHAREDNET_CONSOLE_TOKEN.",
    );
  });

  it.each(["lookup", "fetch"])(
    "sanitizes an unexpected %s failure without logging it",
    async (failureSource) => {
      const consoleToken = "console-token-that-must-not-leak";
      const databasePath = "/private/database/path-that-must-not-leak.sqlite";
      const rawBody = "raw response body that must not leak";
      const sql = 'SELECT id FROM "user" WHERE email = secret';
      const privateError = [consoleToken, databasePath, rawBody, sql].join(" | ");
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const consoleLog = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      let caught: unknown;
      let consoleErrorCallCount = -1;
      let consoleLogCallCount = -1;

      try {
        await seedDemoAccount({
          ...successfulOptions(async () => {
            if (failureSource === "fetch") {
              throw new Error(privateError);
            }
            return Response.json(validSeedResult);
          }),
          consoleToken,
          lookup: {
            close() {},
            findUserIdsByEmail() {
              if (failureSource === "lookup") {
                throw new Error(privateError);
              }
              return ["auth-user-id"];
            },
          },
        });
      } catch (error) {
        caught = error;
      } finally {
        consoleErrorCallCount = consoleError.mock.calls.length;
        consoleLogCallCount = consoleLog.mock.calls.length;
        consoleError.mockRestore();
        consoleLog.mockRestore();
      }

      expect(caught).toEqual(
        new DemoSeedError("Demo seed failed."),
      );
      for (const privateValue of [consoleToken, databasePath, rawBody, sql]) {
        expect(String(caught)).not.toContain(privateValue);
      }
      expect(consoleErrorCallCount).toBe(0);
      expect(consoleLogCallCount).toBe(0);
    },
  );

  it.each(["lookup", "fetch"])(
    "sanitizes a dependency-created DemoSeedError from %s",
    async (failureSource) => {
      const privateMessage =
        "private dependency error with token, path, body, stack, and SQL";
      let caught: unknown;

      try {
        await seedDemoAccount({
          ...successfulOptions(async () => {
            if (failureSource === "fetch") {
              throw new DemoSeedError(privateMessage);
            }
            return Response.json(validSeedResult);
          }),
          lookup: {
            close() {},
            findUserIdsByEmail() {
              if (failureSource === "lookup") {
                throw new DemoSeedError(privateMessage);
              }
              return ["auth-user-id"];
            },
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toEqual(new DemoSeedError("Demo seed failed."));
      expect(String(caught)).not.toContain(privateMessage);
    },
  );

  it("rejects a blank Console token at the core boundary", async () => {
    await expect(
      seedDemoAccount({
        ...successfulOptions(async () => Response.json(validSeedResult)),
        consoleToken: "   ",
      }),
    ).rejects.toThrow("SHAREDNET_CONSOLE_TOKEN is required.");
  });

  it("looks up Better Auth user IDs by exact normalized email", () => {
    const databasePath = createAuthDatabase([
      { email: "xisen.demo@sharednet.local", id: "user-exact" },
      { email: "XISEN.DEMO@SHAREDNET.LOCAL", id: "user-uppercase" },
      { email: " xisen.demo@sharednet.local ", id: "user-spaced" },
    ]);
    const lookup = new SqliteAuthUserLookup(databasePath);

    try {
      expect(
        lookup.findUserIdsByEmail("xisen.demo@sharednet.local"),
      ).toEqual(["user-exact"]);
    } finally {
      lookup.close();
    }
  });

  it("closes the SQLite adapter without leaking database errors", () => {
    const databasePath = createAuthDatabase([
      { email: "xisen.demo@sharednet.local", id: "user-exact" },
    ]);
    const lookup = new SqliteAuthUserLookup(databasePath);

    lookup.close();

    expect(() =>
      lookup.findUserIdsByEmail("xisen.demo@sharednet.local"),
    ).toThrow("Better Auth user lookup failed.");
    expect(() => lookup.close()).not.toThrow();
  });

  it("exposes a package command that fails generically without required environment", async () => {
    const result = await runCommand(
      "pnpm",
      [
        "--silent",
        "demo:seed",
        "--",
        "--email",
        "xisen.demo@sharednet.local",
      ],
      commandEnvironment(),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Demo seed failed.\n");
  });

  it("runs against a temporary database and fake local seed endpoint", async () => {
    const email = "xisen.demo@sharednet.local";
    const authUserId = "auth/user?# id";
    const consoleToken = "temporary-console-token";
    const databasePath = createAuthDatabase([{ email, id: authUserId }]);
    const requests: Array<{
      consoleToken: string | undefined;
      method: string | undefined;
      url: string | undefined;
    }> = [];
    const server = createServer((request, response) => {
      requests.push({
        consoleToken: request.headers["x-sharednet-console-token"] as
          | string
          | undefined,
        method: request.method,
        url: request.url,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validSeedResult));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const result = await runCommand(
        process.execPath,
        [
          "--experimental-strip-types",
          join(projectRoot, "scripts/seed-demo-account.mjs"),
          "--email",
          email,
        ],
        commandEnvironment({
          BETTER_AUTH_DATABASE_PATH: databasePath,
          SHAREDNET_API_URL: `http://127.0.0.1:${address.port}`,
          SHAREDNET_CONSOLE_TOKEN: consoleToken,
        }),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(validSeedResult);
      for (const privateValue of [
        email,
        authUserId,
        consoleToken,
        databasePath,
      ]) {
        expect(result.stdout).not.toContain(privateValue);
        expect(result.stderr).not.toContain(privateValue);
      }
      expect(requests).toEqual([
        {
          consoleToken,
          method: "POST",
          url: "/v1/console/accounts/auth%2Fuser%3F%23%20id/demo-seed",
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
