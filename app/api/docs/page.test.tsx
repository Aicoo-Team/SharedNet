import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ENDPOINTS } from "@/src/api-docs/catalogue";
import { ERROR_STATUS } from "@/packages/protocol/src/index.ts";

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

  it("marks routes that are advertised but unimplemented", () => {
    render(<ApiDocsPage />);

    const card = document.getElementById("getRoom");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("Not implemented")).toBeVisible();
  });

  it("renders every protocol error code so the table cannot drift", () => {
    render(<ApiDocsPage />);

    for (const code of Object.keys(ERROR_STATUS)) {
      expect(screen.getAllByText(code).length).toBeGreaterThan(0);
    }
  });
});
