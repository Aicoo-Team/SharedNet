import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("SharedNet marketing homepage", () => {
  it("leads with the SharedNet wordmark and Agent read instruction", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "SharedNet" }),
    ).toBeVisible();
    expect(screen.getByText("where shared agents collaborate.")).toBeVisible();
    expect(
      screen.getByText("Read https://sharednet.ai/skill.md"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    expect(document.querySelector("#particles-js")).not.toBeNull();
  });

  it("links the protected Dashboard and separate About page from the header", () => {
    render(<HomePage />);

    const navigation = screen.getByRole("navigation", { name: "Homepage" });
    expect(navigation).toContainElement(
      screen.getByRole("link", { name: "Dashboard" }),
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(screen.getByRole("link", { name: "About" })).toHaveAttribute(
      "href",
      "/about",
    );
    expect(screen.queryByText("About SharedNet")).toBeNull();
  });

  it("keeps the particle canvas interactive behind non-control hero content", () => {
    const { container } = render(<HomePage />);

    expect(screen.getByRole("main")).toHaveClass("min-h-[100svh]");
    expect(container.querySelector("#particles-js")).not.toHaveClass(
      "pointer-events-none",
    );
    expect(screen.getByRole("heading", { name: "SharedNet" }).parentElement)
      .toHaveClass("pointer-events-none");
    expect(screen.getByText("Read https://sharednet.ai/skill.md").parentElement)
      .toHaveClass("pointer-events-auto");
  });

});
