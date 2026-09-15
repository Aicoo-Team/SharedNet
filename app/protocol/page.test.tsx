import { describe, expect, it } from "vitest";
import { metadata } from "./page";

describe("Protocol page metadata", () => {
  it("names the current Room-join product boundary", () => {
    // The root layout's template appends "— SharedNet"; a page that added it
    // too produced "Room Join Protocol — SharedNet — SharedNet".
    expect(metadata.title).toBe("Room join protocol");
    expect(metadata.description).toContain("join one existing SharedNet Room");
  });
});
