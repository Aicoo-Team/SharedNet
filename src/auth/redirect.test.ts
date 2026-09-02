import { describe, expect, it } from "vitest";

import { safePostAuthPath } from "./redirect";

describe("safePostAuthPath", () => {
  it.each([
    ["/chat", "/chat"],
    ["/network", "/network"],
    ["/decisions", "/decisions"],
    ["/chat/room_7F3K?message=message_12#reply", "/chat/room_7F3K?message=message_12#reply"],
    ["/network/agent_42", "/network/agent_42"],
    ["/decisions/review_9", "/decisions/review_9"],
    ["/protocol", "/protocol"],
  ])("keeps the trusted in-app destination %s", (candidate, expected) => {
    expect(safePostAuthPath(candidate)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "/",
    "/login",
    "/chatty",
    "https://attacker.example/chat",
    "//attacker.example/chat",
    "/\\attacker.example/chat",
    "/%2f%2fattacker.example/chat",
    "javascript:alert(1)",
  ])("falls back to Chat for an untrusted destination (%s)", (candidate) => {
    expect(safePostAuthPath(candidate)).toBe("/chat");
  });
});
