// @vitest-environment node

import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultKeyHasher } from "@better-auth/api-key";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  API_KEY_ID_PATTERN,
  SNK_SECRET_PATTERN,
} from "../../packages/protocol/src/index.ts";

const testDirectory = mkdtempSync(join(tmpdir(), "sharednet-better-auth-"));
const databasePath = join(testDirectory, "auth.sqlite");
const baseURL = "http://127.0.0.1:3001";

type AuthModule = typeof import("../../lib/auth");

let authModule: AuthModule;
let auth: ReturnType<AuthModule["getAuth"]>;

beforeAll(async () => {
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "test-only-sharednet-secret-with-at-least-thirty-two-characters",
  );
  vi.stubEnv("BETTER_AUTH_URL", baseURL);
  vi.stubEnv("BETTER_AUTH_DATABASE_PATH", databasePath);

  writeFileSync(databasePath, "", { mode: 0o644 });
  chmodSync(databasePath, 0o644);

  authModule = await import("../../lib/auth");
  auth = authModule.getAuth();
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(testDirectory, { force: true, recursive: true });
});

describe("Better Auth integration", () => {
  it("creates an owner-only database", () => {
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("registers, signs in, and resolves an email/password session", async () => {
    const email = "ada@example.com";
    const password = "a-secure-test-password";

    const signUpResponse = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-up/email`, {
        body: JSON.stringify({ email, name: "Ada Lovelace", password }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(signUpResponse.status).toBe(200);
    expect(await signUpResponse.json()).toMatchObject({
      user: { email, name: "Ada Lovelace" },
    });

    const signInResponse = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const sessionCookie = signInResponse.headers.get("set-cookie");

    expect(signInResponse.status).toBe(200);
    expect(sessionCookie).toContain("better-auth.session_token=");

    const sessionResponse = await auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: sessionCookie ?? "" },
      }),
    );

    expect(sessionResponse.status).toBe(200);
    const resolvedSession = await sessionResponse.json();
    expect(resolvedSession).toMatchObject({
      session: { userId: expect.any(String) },
      user: { email, name: "Ada Lovelace" },
    });

    const createKeyResponse = await auth.handler(
      new Request(`${baseURL}/api/auth/api-key/create`, {
        body: JSON.stringify({ name: "Ada's local Codex" }),
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie ?? "",
        },
        method: "POST",
      }),
    );
    const createdKey = (await createKeyResponse.json()) as {
      id: string;
      key: string;
      referenceId: string;
    };

    expect(createKeyResponse.status).toBe(200);
    expect(createdKey.id).toMatch(API_KEY_ID_PATTERN);
    expect(createdKey.key).toMatch(SNK_SECRET_PATTERN);
    expect(createdKey.referenceId).toBe(resolvedSession.user.id);

    const database = new Database(databasePath, { readonly: true });
    const storedKey = database
      .prepare("SELECT key FROM apikey WHERE id = ?")
      .get(createdKey.id) as { key: string };
    database.close();

    expect(storedKey.key).toBe(await defaultKeyHasher(createdKey.key));
    expect(storedKey.key).not.toBe(createdKey.key);

    await expect(
      auth.api.verifyApiKey({ body: { key: createdKey.key } }),
    ).resolves.toMatchObject({
      key: { id: createdKey.id, referenceId: resolvedSession.user.id },
      valid: true,
    });

    const apiKeySessionResponse = await auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { "x-api-key": createdKey.key },
      }),
    );

    expect(apiKeySessionResponse.status).toBe(200);
    expect(await apiKeySessionResponse.json()).toBeNull();
  });

  it("runs the injected Principal provisioner after creating a user", async () => {
    const database = new Database(databasePath);
    const afterUserCreated = vi.fn(async () => undefined);
    const provisionedAuth = authModule.createSharedNetAuth({
      afterUserCreated,
      baseURL,
      database,
      secret:
        "principal-hook-test-secret-with-at-least-thirty-two-characters",
    });

    const response = await provisionedAuth.handler(
      new Request(`${baseURL}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          email: "grace@example.com",
          name: "Grace Hopper",
          password: "another-secure-test-password",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    database.close();

    expect(response.status).toBe(200);
    expect(afterUserCreated).toHaveBeenCalledOnce();
    expect(afterUserCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "grace@example.com",
        id: expect.any(String),
        name: "Grace Hopper",
      }),
      expect.anything(),
    );
  });

  it("exports the React client and the Next.js GET/POST handlers", async () => {
    const [{ authClient }, route] = await Promise.all([
      import("../../lib/auth-client"),
      import("../../app/api/auth/[...all]/route"),
    ]);

    expect(authClient.signIn.email).toBeTypeOf("function");
    expect(authClient.signUp.email).toBeTypeOf("function");
    expect(authClient.apiKey.create).toBeTypeOf("function");
    expect(authClient.apiKey.list).toBeTypeOf("function");
    expect(route.GET).toBeTypeOf("function");
    expect(route.POST).toBeTypeOf("function");

    const response = await route.GET(
      new Request(`${baseURL}/api/auth/get-session`),
    );
    expect(response.status).toBe(200);
  });
});
