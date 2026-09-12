import { describe, expect, it } from "vitest";

import { resolveTrustedOrigins } from "../../lib/auth.ts";

describe("resolveTrustedOrigins", () => {
  it("trusts both production hostnames in every environment", () => {
    for (const nodeEnv of ["production", "development", "test"]) {
      const origins = resolveTrustedOrigins({ NODE_ENV: nodeEnv });
      expect(origins).toContain("https://sharednet.ai");
      expect(origins).toContain("https://www.sharednet.ai");
    }
  });

  it("trusts both spellings of both development ports outside production", () => {
    const origins = resolveTrustedOrigins({ NODE_ENV: "development" });
    expect(origins).toContain("http://localhost:3000");
    expect(origins).toContain("http://localhost:3001");
    expect(origins).toContain("http://127.0.0.1:3000");
    expect(origins).toContain("http://127.0.0.1:3001");
  });

  it("withholds every loopback origin in production", () => {
    const origins = resolveTrustedOrigins({ NODE_ENV: "production" });
    expect(origins.filter((o) => /localhost|127\.0\.0\.1/.test(o))).toEqual([]);
  });

  it("trusts the deployment's own Vercel hostname over https", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      VERCEL_URL: "shared-net-abc123.vercel.app",
    });
    expect(origins).toContain("https://shared-net-abc123.vercel.app");
  });

  it("trusts the branch alias a preview is actually opened at", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      VERCEL_URL: "shared-net-abc123.vercel.app",
      VERCEL_BRANCH_URL: "shared-net-git-feat-google.vercel.app",
    });
    expect(origins).toContain("https://shared-net-abc123.vercel.app");
    expect(origins).toContain("https://shared-net-git-feat-google.vercel.app");
  });

  it("ignores a blank VERCEL_BRANCH_URL rather than trusting https://", () => {
    const origins = resolveTrustedOrigins({ NODE_ENV: "production", VERCEL_BRANCH_URL: " " });
    expect(origins).not.toContain("https://");
  });

  it("ignores a blank VERCEL_URL rather than trusting https://", () => {
    const origins = resolveTrustedOrigins({ NODE_ENV: "production", VERCEL_URL: "  " });
    expect(origins).not.toContain("https://");
  });

  it("adds configured origins and drops the empty entries of a trailing comma", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      SHAREDNET_TRUSTED_ORIGINS: "https://staging.sharednet.ai, https://a.example, ,",
    });
    expect(origins).toContain("https://staging.sharednet.ai");
    expect(origins).toContain("https://a.example");
    expect(origins.every((origin) => origin.length > 0)).toBe(true);
  });

  it("returns each origin once when a configured origin repeats a default", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      SHAREDNET_TRUSTED_ORIGINS: "https://sharednet.ai",
    });
    expect(origins.filter((o) => o === "https://sharednet.ai")).toHaveLength(1);
  });

  it("treats a missing NODE_ENV as non-production so a bare local run works", () => {
    expect(resolveTrustedOrigins({})).toContain("http://localhost:3000");
  });
});
