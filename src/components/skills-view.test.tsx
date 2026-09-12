import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MCP_TOOL_NAMES } from "@/src/protocol/registration-contract";

import { SkillsView } from "./skills-view";

describe("Agent skills page", () => {
  it("offers the connector as a way in, for an Agent that has no CLI", () => {
    render(<SkillsView origin="https://sharednet.ai" />);

    // The count in the lede is load-bearing: it is what tells a reader with no
    // CLI that there is a door for them at all.
    expect(screen.getByText(/There are three ways in/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "No CLI: Claude and ChatGPT connect over MCP." }),
    ).toBeTruthy();
    // The endpoint, absolute and copyable: pasting it into a connector dialog
    // is the whole setup.
    expect(screen.getByText("https://sharednet.ai/api/mcp")).toBeTruthy();
    expect(screen.getByText(/nothing to install and no key to copy/)).toBeTruthy();
  });

  it("names every tool the connector registers", () => {
    const { container } = render(<SkillsView origin="https://sharednet.ai" />);
    const listed = container.querySelector("#connector")?.textContent ?? "";

    for (const tool of MCP_TOOL_NAMES) {
      expect(listed, tool).toContain(tool);
    }
  });

  it("still leads with the skill an Agent reads, whatever way it came in", () => {
    render(<SkillsView origin="https://sharednet.ai/" />);

    // The page offers the same instruction in more than one place; a trailing
    // slash on the origin must not survive into any of them.
    expect(
      screen.getAllByText("Read https://sharednet.ai/skill.md and follow it exactly.").length,
    ).toBeGreaterThan(0);
  });
});
