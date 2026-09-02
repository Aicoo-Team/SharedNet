import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SharedNetDemoProvider } from "@/src/context/sharednet-demo-context";
import { DecisionsView } from "./decisions-view";

function renderDecisions() {
  return render(
    <SharedNetDemoProvider>
      <DecisionsView />
    </SharedNetDemoProvider>,
  );
}

describe("SharedNet Decisions", () => {
  beforeEach(() => window.localStorage.clear());

  it("presents one selected decision with deny, approve-once, and approve-all controls", () => {
    renderDecisions();

    expect(screen.getByRole("heading", { level: 1, name: "Decisions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show past decisions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve all pending" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Work on A first…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply instruction" })).toBeTruthy();
  });

  it("approves the selected decision once and reveals it through the history control", () => {
    renderDecisions();
    const pending = screen.getByRole("region", { name: "Pending decisions" });
    const title = "Aicoo wants to use your Research Agent";

    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));

    expect(within(pending).queryByRole("heading", { name: title })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show past decisions" }));
    const resolved = screen.getByRole("region", { name: "Resolved decisions" });
    expect(within(resolved).getByRole("heading", { name: title })).toBeTruthy();
    expect(within(resolved).getByText("Approved")).toBeTruthy();
  });

  it("records a human instruction when approving the selected decision", () => {
    renderDecisions();
    fireEvent.change(screen.getByPlaceholderText("Work on A first…"), {
      target: { value: "Research the auth boundary first." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply instruction" }));
    fireEvent.click(screen.getByRole("button", { name: "Show past decisions" }));

    expect(
      within(screen.getByRole("region", { name: "Resolved decisions" })).getByText(
        "Research the auth boundary first.",
      ),
    ).toBeTruthy();
  });

  it("can approve every pending decision from the green control", () => {
    renderDecisions();
    fireEvent.click(screen.getByRole("button", { name: "Approve all pending" }));

    expect(screen.getByText("No decisions need you.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
  });
});
