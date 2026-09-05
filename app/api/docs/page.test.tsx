import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ENDPOINTS } from "@/src/api-docs/catalogue";
import { ERROR_STATUS, ROUTE_CATALOGUE } from "@/packages/protocol/src/index.ts";

import ApiDocsPage from "./page";

describe("SharedNet API reference page", () => {
  it("documents every route the catalogue knows about", () => {
    render(<ApiDocsPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "The SharedNet V1 API." }),
    ).toBeVisible();

    for (const endpoint of ENDPOINTS) {
      expect(document.getElementById(endpoint.operationId)).not.toBeNull();
    }
  });

  it("documents every published route as implemented", () => {
    render(<ApiDocsPage />);

    expect(ENDPOINTS.every((endpoint) => endpoint.status === "live")).toBe(true);
    expect(screen.queryByText("Not implemented")).toBeNull();
  });

  it("keeps the reference in step with the published route catalogue", () => {
    render(<ApiDocsPage />);

    for (const route of ROUTE_CATALOGUE) {
      expect(document.getElementById(route.operationId)).not.toBeNull();
    }
  });

  it("wears the shared public look and points guests at the protocol page", () => {
    render(<ApiDocsPage />);

    expect(screen.getByRole("navigation", { name: "Public pages" })).toBeTruthy();
    expect(document.querySelector("#particles-js")).not.toBeNull();
    expect(document.querySelector(".public-particle-blur")).not.toBeNull();
    expect(screen.getByRole("link", { name: "protocol page" })).toHaveAttribute(
      "href",
      "/protocol",
    );
    expect(screen.getByText(`${ENDPOINTS.length} routes.`, { exact: false })).toBeTruthy();
  });

  it("renders every protocol error code so the table cannot drift", () => {
    render(<ApiDocsPage />);

    for (const code of Object.keys(ERROR_STATUS)) {
      expect(screen.getAllByText(code).length).toBeGreaterThan(0);
    }
  });
});
