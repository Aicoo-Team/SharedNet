import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("../../lib/auth", () => ({
  auth: {
    api: {
      getSession,
    },
  },
}));

import { config, proxy } from "../../proxy";

describe("authentication proxy", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  it("redirects a request without a database-backed session to login", async () => {
    getSession.mockResolvedValue(null);
    const request = new NextRequest("http://localhost:3001/chat");

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3001/login?next=%2Fchat",
    );
    expect(getSession).toHaveBeenCalledWith({
      headers: request.headers,
      query: { disableRefresh: true },
    });
  });

  it("preserves only the requested same-origin path and encoded query", async () => {
    getSession.mockResolvedValue(null);
    const request = new NextRequest(
      "https://sharednet.example/network/agents?room=room%20one&return=https%3A%2F%2Fevil.example",
    );

    const response = await proxy(request);
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe("https://sharednet.example");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(
      "/network/agents?room=room%20one&return=https%3A%2F%2Fevil.example",
    );
  });

  it("allows a request with a database-backed Better Auth session", async () => {
    getSession.mockResolvedValue({
      session: { id: "session_1" },
      user: { id: "user_1" },
    });
    const request = new NextRequest("http://localhost:3001/decisions");

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("matches only the authenticated app surfaces", () => {
    expect(config.matcher).toEqual([
      "/chat/:path*",
      "/network/:path*",
      "/decisions/:path*",
      "/protocol/:path*",
    ]);
  });
});
