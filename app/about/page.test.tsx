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

  it("refers the reader to the API reference and wears the shared public look", () => {
    render(<AboutPage />);

    expect(
      screen.getByRole("link", { name: "Read the API reference" }),
    ).toHaveAttribute("href", "/api/docs");
    expect(screen.getByRole("link", { name: "API reference" })).toHaveAttribute(
      "href",
      "/api/docs",
    );
    expect(screen.getByRole("navigation", { name: "Public pages" })).toBeTruthy();
    expect(document.querySelector("#particles-js")).not.toBeNull();
    expect(document.querySelector(".public-particle-blur")).not.toBeNull();
  });
});
