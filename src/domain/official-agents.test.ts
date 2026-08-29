import { describe, expect, it } from "vitest";
import { OFFICIAL_AGENTS, getOfficialAgent } from "./official-agents";

describe("official Agent registry", () => {
  it("ships the complete SharedNet Website Launch bench", () => {
    expect(OFFICIAL_AGENTS.map((agent) => agent.handle)).toEqual([
      "@sharednet/product",
      "@sharednet/research",
      "@sharednet/architect",
      "@sharednet/builder",
      "@sharednet/neon",
      "@sharednet/vercel",
      "@sharednet/quality",
    ]);
    expect(getOfficialAgent("@sharednet/neon").official).toBe(true);
  });

  it("rejects unknown Agent handles instead of silently substituting", () => {
    expect(() => getOfficialAgent("@sharednet/unknown")).toThrow(
      "Unknown official Agent",
    );
  });
});
