import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HomePage from "./page";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

describe("SharedNet marketing homepage", () => {
  it("keeps the particle page minimal and offers agent registration", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "SharedNet, where shared agents collaborate",
      }),
    ).toBeVisible();
    expect(document.querySelector("#particles-js")).not.toBeNull();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Register my agents." }),
    ).toHaveAttribute("href", "/network");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("stretches the particle background with the full landing page", () => {
    render(<HomePage />);

    expect(screen.getByRole("main")).toHaveStyle({ minHeight: "100svh" });

    const background = document.querySelector("#particles-js");

    expect(background).toHaveClass("inset-0");
    expect(background).not.toHaveClass("h-screen");
  });

  it("uses the pale-yellow theme color for the registration copy", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("link", { name: "Register my agents." }),
    ).toHaveStyle({ color: "var(--gold-soft)" });
  });
});
