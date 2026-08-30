import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SharedNetDemoProvider,
  useSharedNetDemo,
} from "@/src/context/sharednet-demo-context";
import { NetworkView } from "./network-view";

function renderNetwork() {
  return render(
    <SharedNetDemoProvider>
      <NetworkView />
    </SharedNetDemoProvider>,
  );
}

function RecruitmentHarness() {
  const { state, submitPrompt, resolveDecision } = useSharedNetDemo();
  const recruitmentDecision = state.decisions.find(
    (decision) => decision.type === "recruitment" && decision.status === "pending",
  );
  return (
    <>
      <button type="button" onClick={() => submitPrompt("Build a website")}>Seed task</button>
      <button
        type="button"
        disabled={!recruitmentDecision}
        onClick={() =>
          recruitmentDecision && resolveDecision(recruitmentDecision.id, "denied")
        }
      >
        Deny recruitment
      </button>
      <NetworkView />
    </>
  );
}

describe("SharedNet Network", () => {
  beforeEach(() => window.localStorage.clear());

  it("makes Principal ownership and the cross-Principal boundary explicit", () => {
    renderNetwork();

    const ownPrincipal = screen.getByRole("region", {
      name: "Your Principal @xisen",
    });
    const connectedPrincipal = screen.getByRole("region", {
      name: "Connected Principal @aicoo",
    });

    expect(within(ownPrincipal).getByText("@xisen/planner")).toBeTruthy();
    expect(within(ownPrincipal).getByText("@xisen/codex")).toBeTruthy();
    expect(within(connectedPrincipal).getByText("@aicoo/web-builder")).toBeTruthy();
    expect(within(connectedPrincipal).getByText("@aicoo/design-engineer")).toBeTruthy();
    expect(within(connectedPrincipal).getByText("@aicoo/neon")).toBeTruthy();
    expect(within(connectedPrincipal).getByText("@aicoo/vercel")).toBeTruthy();
    expect(within(connectedPrincipal).getByText("@aicoo/quality")).toBeTruthy();
    expect(screen.getByText("@xisen ↔ @aicoo")).toBeTruthy();
    expect(screen.getByText("Intra-Principal boundary")).toBeTruthy();
    expect(screen.getByText("Cross-Principal connection")).toBeTruthy();
    expect(screen.getByText("Task recruitment")).toBeTruthy();
  });

  it("reveals AgentCard runtime metadata and usage without a fourth page", () => {
    renderNetwork();

    fireEvent.click(screen.getByRole("button", { name: "Inspect @aicoo/neon" }));

    const details = screen.getByRole("region", { name: "Agent details" });
    expect(within(details).getByRole("heading", { name: "@aicoo/neon" })).toBeTruthy();
    expect(within(details).getByText("Aicoo Cloud")).toBeTruthy();
    expect(within(details).getByText("Provider-isolated sandbox")).toBeTruthy();
    expect(within(details).getByText("Connections can discover")).toBeTruthy();
  });

  it("keeps task recruitment separate from connection state and labels its outcome", () => {
    render(
      <SharedNetDemoProvider>
        <RecruitmentHarness />
      </SharedNetDemoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Seed task" }));

    const connectedPrincipal = screen.getByRole("region", {
      name: "Connected Principal @aicoo",
    });
    expect(within(connectedPrincipal).getAllByText("REQUESTED")).toHaveLength(5);

    fireEvent.click(screen.getByRole("button", { name: "Deny recruitment" }));
    expect(within(connectedPrincipal).getAllByText("DECLINED")).toHaveLength(5);
    expect(within(connectedPrincipal).queryByText("TASK")).toBeNull();
    expect(screen.getByText("Denied · 5 Agents")).toBeTruthy();
  });
});
