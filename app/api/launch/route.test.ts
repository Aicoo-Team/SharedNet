import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

function liveRequest() {
  return new Request("http://localhost/api/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: "signal-board",
      mode: "live",
      requiresDatabase: true,
      approvedExternalActions: true,
    }),
  });
}

describe("POST /api/launch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses live writes until the operator explicitly enables them", async () => {
    vi.stubEnv("NEON_API_KEY", "neon-secret");
    vi.stubEnv("VERCEL_TOKEN", "vercel-secret");
    vi.stubEnv("SHAREDNET_ENABLE_LIVE_CONNECTORS", "false");

    const response = await POST(liveRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Live connectors are disabled by the SharedNet operator.",
    });
  });
});
