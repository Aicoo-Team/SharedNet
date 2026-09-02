import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SharedNetDemoProvider } from "@/src/context/sharednet-demo-context";
import { NetworkView } from "./network-view";

function renderNetwork() {
  return render(
    <SharedNetDemoProvider>
      <NetworkView />
    </SharedNetDemoProvider>,
  );
}

describe("SharedNet Network", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders the intra-Principal relationship matrix with weighted line multiplicity", () => {
    renderNetwork();

    const graph = screen.getByRole("region", { name: "Relationship graph" });
    expect(screen.getByRole("button", { name: "Intra-Principal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Cross-Principal" })).toBeTruthy();
    expect(within(graph).getByText("Same Principal ID")).toBeTruthy();
    expect(
      graph.querySelectorAll(
        '[data-edge-id="planner-codex"][data-edge-kind="shared-room"]',
      ),
    ).toHaveLength(3);
    expect(
      graph.querySelectorAll(
        '[data-edge-id="planner-codex"][data-edge-kind="delegation"]',
      ),
    ).toHaveLength(2);
    expect(screen.getByText("dotted · rooms together")).toBeTruthy();
    expect(screen.getByText("solid · direct delegation")).toBeTruthy();
  });

  it("shows identity metadata in a closable Agent Card", () => {
    renderNetwork();

    fireEvent.click(screen.getByRole("button", { name: "Inspect @xisen/codex" }));

    const card = screen.getByRole("region", { name: "Agent Card" });
    expect(within(card).getByText("principal-xisen")).toBeTruthy();
    expect(within(card).getByText("agent-xisen-codex")).toBeTruthy();
    expect(within(card).getByText("runtime-local-xisen-codex")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close Agent Card" }));
    expect(screen.queryByRole("region", { name: "Agent Card" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Agent Card" })).toBeTruthy();
  });

  it("switches to cross-Principal memory without losing Agent selection", () => {
    renderNetwork();

    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));
    const graph = screen.getByRole("region", { name: "Relationship graph" });
    expect(within(graph).getByText("Different Principal IDs")).toBeTruthy();
    expect(within(graph).getByRole("button", { name: "Inspect @xisen/planner" })).toBeTruthy();
    expect(within(graph).getByRole("button", { name: "Inspect @aicoo/web-builder" })).toBeTruthy();
    expect(graph.querySelectorAll('[data-scope="cross"]')).not.toHaveLength(0);

    fireEvent.click(within(graph).getByRole("button", { name: "Inspect @aicoo/web-builder" }));
    expect(
      within(screen.getByRole("region", { name: "Agent Card" })).getByText(
        "principal-aicoo",
      ),
    ).toBeTruthy();
  });
});
