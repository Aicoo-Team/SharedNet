import { describe, expect, it, vi } from "vitest";
import { getConnectorStatus } from "./index";
import { createNeonConnector } from "./neon";
import { createVercelConnector } from "./vercel";

describe("provider connector safety", () => {
  it("simulates without credentials and never calls the network", async () => {
    const fetcher = vi.fn();
    const neon = createNeonConnector({}, fetcher);
    const vercel = createVercelConnector({}, fetcher);

    const neonResult = await neon.execute(await neon.plan({ slug: "signal-board" }), true);
    const vercelResult = await vercel.execute(
      await vercel.plan({ slug: "signal-board" }),
      true,
    );

    expect(neonResult.label).toBe("SIMULATED");
    expect(vercelResult.details.url).toBe(
      "https://signal-board.sharednet-demo.local",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses live execution without explicit approval", async () => {
    const vercel = createVercelConnector({ VERCEL_TOKEN: "secret" }, vi.fn());

    await expect(
      vercel.execute(await vercel.plan({ slug: "signal-board" }), false),
    ).rejects.toThrow("approval");
  });

  it("keeps credentials in the server request and redacts returned connection data", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ project: { id: "neon-project-1" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ uri: "postgresql://owner:password@example.test/app" }),
      });
    const neon = createNeonConnector({ NEON_API_KEY: "server-secret" }, fetcher);
    const result = await neon.execute(
      await neon.plan({ slug: "signal-board" }),
      true,
    );
    const redacted = neon.redact(result);

    expect(fetcher).toHaveBeenCalledWith(
      "https://console.neon.tech/api/v2/projects",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer server-secret" }),
      }),
    );
    expect(result.details.connectionUri).toContain("password");
    expect(redacted.details.connectionUri).toBe("[REDACTED]");
  });

  it("surfaces ambiguous external writes for reconciliation instead of retrying", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const neon = createNeonConnector({ NEON_API_KEY: "server-secret" }, fetcher);
    const result = await neon.execute(
      await neon.plan({ slug: "signal-board" }),
      true,
    );

    expect(result.status).toBe("reconciliation-required");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports connector readiness without echoing secrets", () => {
    const status = getConnectorStatus({
      NEON_API_KEY: "neon-secret",
      VERCEL_TOKEN: "vercel-secret",
    });

    expect(status).toEqual({
      neon: { mode: "live", available: true, credentialConfigured: true },
      vercel: { mode: "live", available: true, credentialConfigured: true },
    });
    expect(JSON.stringify(status)).not.toContain("secret");
  });
});
