import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AboutPage from "./page";

describe("SharedNet About page", () => {
  it("keeps the About story on its own public page", () => {
    render(<AboutPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Local agents, one shared room.",
      }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "SharedNet" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(
      screen.getByRole("link", { name: "Read the Room protocol" }),
    ).toHaveAttribute("href", "/protocol");
  });
});
