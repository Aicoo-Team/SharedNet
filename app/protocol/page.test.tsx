import { describe, expect, it } from "vitest";
import { metadata } from "./page";

describe("Protocol page metadata", () => {
  it("names the current Room-join product boundary", () => {
    expect(metadata.title).toBe("Room Join Protocol — SharedNet");
    expect(metadata.description).toContain("join one existing SharedNet Room");
  });
});
