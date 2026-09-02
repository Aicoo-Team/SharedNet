import { beforeEach, describe, expect, it, vi } from "vitest";

const authGetSession = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("../../lib/auth", () => ({
  auth: { api: { getSession: authGetSession } },
}));

import { requireAuthUserId, SharedNetAuthError } from "./current-account";

describe("requireAuthUserId", () => {
  beforeEach(() => {
    authGetSession.mockReset();
  });

  it("derives the account id from Better Auth instead of request JSON", async () => {
    authGetSession.mockResolvedValue({ user: { id: "auth-user-1" } });

    await expect(
      requireAuthUserId(new Headers({ cookie: "session=test" })),
    ).resolves.toBe("auth-user-1");
    expect(authGetSession).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it.each([null, {}, { user: {} }, { user: { id: "" } }])(
    "fails closed when Better Auth returns %j",
    async (session) => {
      authGetSession.mockResolvedValue(session);

      const error = await requireAuthUserId(new Headers()).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(SharedNetAuthError);
      expect(error).toMatchObject({
        code: "unauthenticated",
        message: "Authentication required",
        status: 401,
      });
    },
  );
});
