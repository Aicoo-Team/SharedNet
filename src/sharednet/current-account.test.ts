import { beforeEach, describe, expect, it, vi } from "vitest";

const authGetSession = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("../../lib/auth", () => ({
  getAuth: () => ({ api: { getSession: authGetSession } }),
  resolveTrustedOrigins: () => ["https://www.sharednet.ai"],
}));

import { assertTrustedWebOrigin, requireAuthUserId, requireWebMutation, SharedNetAuthError, SharedNetOriginError } from "./current-account";

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

describe("the Web mutation boundary", () => {
  beforeEach(() => {
    authGetSession.mockReset();
  });

  const post = (headers: Record<string, string>, url = "https://sharednet.ai/api/sharednet/rooms") =>
    new Request(url, { method: "POST", headers });

  it("lets a request from our own page through, with or without Fetch Metadata", () => {
    expect(() => assertTrustedWebOrigin(post({ origin: "https://sharednet.ai" }))).not.toThrow();
    expect(() => assertTrustedWebOrigin(post({ origin: "https://sharednet.ai", "sec-fetch-site": "same-origin" }))).not.toThrow();
    // A configured trusted origin, such as the www host, counts too.
    expect(() => assertTrustedWebOrigin(post({ origin: "https://www.sharednet.ai", "sec-fetch-site": "same-site" }))).not.toThrow();
  });

  it("refuses a mutation from another page, from no page, or that Fetch Metadata calls cross-site", () => {
    const foreign: Record<string, string>[] = [
      {},
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "https://sharednet.ai", "sec-fetch-site": "cross-site" },
    ];
    for (const headers of foreign) {
      expect(() => assertTrustedWebOrigin(post(headers)), JSON.stringify(headers)).toThrow(SharedNetOriginError);
    }
  });

  it("leaves reads alone", () => {
    expect(() => assertTrustedWebOrigin(new Request("https://sharednet.ai/api/sharednet/rooms"))).not.toThrow();
  });

  it("checks the origin before it reads the session, so a foreign page never even costs a lookup", async () => {
    authGetSession.mockResolvedValue({ user: { id: "auth-user-1" } });
    await expect(requireWebMutation(post({ origin: "https://evil.example", cookie: "session=test" }))).rejects.toBeInstanceOf(SharedNetOriginError);
    expect(authGetSession).not.toHaveBeenCalled();
    await expect(requireWebMutation(post({ origin: "https://sharednet.ai", cookie: "session=test" }))).resolves.toBe("auth-user-1");
  });
});
