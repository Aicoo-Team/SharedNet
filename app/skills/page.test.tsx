import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SkillsPage from "./page";

describe("SharedNet Skills page", () => {
  it("publishes both Skills and how to hand one to an Agent", () => {
    render(<SkillsPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Teach an agent to use SharedNet.",
      }),
    ).toBeVisible();

    expect(screen.getByText("sharednet-room")).toBeVisible();
    expect(screen.getByText("sharednet-room-join")).toBeVisible();
    expect(screen.getByRole("link", { name: "Fetch /skill.md" })).toHaveAttribute(
      "href",
      "/skill.md",
    );
    expect(screen.getByRole("link", { name: "API reference" })).toHaveAttribute(
      "href",
      "/api/docs",
    );
  });

  it("keeps the identity boundary visible", () => {
    render(<SkillsPage />);

    expect(
      screen.getByText("Inventing a Principal, Agent, Instance, or Room id."),
    ).toBeVisible();
    expect(
      screen.getByText("Passing an API key or Instance token on argv or in a prompt."),
    ).toBeVisible();
  });
});
