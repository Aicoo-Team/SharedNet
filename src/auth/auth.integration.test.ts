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

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testDirectory = mkdtempSync(join(tmpdir(), "sharednet-better-auth-"));
const databasePath = join(testDirectory, "auth.sqlite");
const baseURL = "http://localhost:3001";

type AuthModule = typeof import("../../lib/auth");

let authModule: AuthModule;

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
  const { runMigrations } = await getMigrations(authModule.auth.options);
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

    const signUpResponse = await authModule.auth.handler(
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

    const signInResponse = await authModule.auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const sessionCookie = signInResponse.headers.get("set-cookie");

    expect(signInResponse.status).toBe(200);
    expect(sessionCookie).toContain("better-auth.session_token=");

    const sessionResponse = await authModule.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: sessionCookie ?? "" },
      }),
    );

    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toMatchObject({
      session: { userId: expect.any(String) },
      user: { email, name: "Ada Lovelace" },
    });
  });

  it("exports the React client and the Next.js GET/POST handlers", async () => {
    const [{ authClient }, route] = await Promise.all([
      import("../../lib/auth-client"),
      import("../../app/api/auth/[...all]/route"),
    ]);

    expect(authClient.signIn.email).toBeTypeOf("function");
    expect(authClient.signUp.email).toBeTypeOf("function");
    expect(route.GET).toBeTypeOf("function");
    expect(route.POST).toBeTypeOf("function");

    const response = await route.GET(
      new Request(`${baseURL}/api/auth/get-session`),
    );
    expect(response.status).toBe(200);
  });
});
