import { beforeEach, describe, expect, it, vi } from "vitest";

const serverAuth = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const nextServer = vi.hoisted(() => ({
  headers: new Headers({ cookie: "better-auth.session_token=session_1" }),
  redirect: vi.fn((destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  }),
}));

vi.mock("../../lib/auth", () => ({
  getAuth: () => ({ api: { getSession: serverAuth.getSession } }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => nextServer.headers),
}));
vi.mock("next/navigation", () => ({
  redirect: nextServer.redirect,
}));
vi.mock("../../components/ui/modern-login-signup", () => ({
  default: function LoginFormBoundary() { return null; },
}));

import LoginPage from "../../app/login/page";

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverAuth.getSession.mockResolvedValue({
      session: {
        createdAt: new Date("2026-09-02T00:00:00Z"),
        expiresAt: new Date("2026-09-09T00:00:00Z"),
        id: "session_1",
        token: "server-only-token",
        updatedAt: new Date("2026-09-02T00:00:00Z"),
        userId: "user_1",
      },
      user: {
        createdAt: new Date("2026-09-02T00:00:00Z"),
        email: "xisen@example.com",
        emailVerified: true,
        id: "user_1",
        image: null,
        name: "Xisen",
        updatedAt: new Date("2026-09-02T00:00:00Z"),
      },
    });
  });

  it.each([
    ["/network?room=room_7F3K", "/network?room=room_7F3K"],
    ["https://attacker.example/chat", "/chat"],
  ])("redirects an existing session to the safe destination for %s", async (next, expected) => {
    await expect(LoginPage({ searchParams: Promise.resolve({ next }) })).rejects.toThrow(
      `NEXT_REDIRECT:${expected}`,
    );
    expect(serverAuth.getSession).toHaveBeenCalledWith({
      headers: nextServer.headers,
      query: { disableRefresh: true },
    });
  });
});
