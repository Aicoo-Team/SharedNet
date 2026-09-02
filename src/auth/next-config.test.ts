import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

describe("Next.js local development origin", () => {
  it("allows the 127.0.0.1 origin used by Better Auth and the in-app browser", () => {
    expect(nextConfig.allowedDevOrigins).toContain("127.0.0.1");
  });
});
