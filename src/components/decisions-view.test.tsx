import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SharedNetDemoProvider,
  useSharedNetDemo,
} from "@/src/context/sharednet-demo-context";
import { DecisionsView } from "./decisions-view";

function Harness() {
  const { submitPrompt } = useSharedNetDemo();
  return (
    <>
      <button type="button" onClick={() => submitPrompt("Build a website")}>
        Seed launch task
      </button>
      <DecisionsView />
    </>
  );
}

function renderDecisions() {
  return render(
    <SharedNetDemoProvider>
      <Harness />
    </SharedNetDemoProvider>,
  );
}

describe("SharedNet Decisions", () => {
  beforeEach(() => window.localStorage.clear());

  it("collects all four authority-bearing decision types in one queue", () => {
    renderDecisions();
    fireEvent.click(screen.getByRole("button", { name: "Seed launch task" }));

    expect(screen.getByText("Recruitment")).toBeTruthy();
    expect(screen.getByText("Authorization")).toBeTruthy();
    expect(screen.getByText("Inbound use")).toBeTruthy();
    expect(screen.getByText("Plan choice")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recruit five Aicoo specialists?" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connect Neon and Vercel for launch?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve demo scopes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review access" })).toBeNull();
  });

  it("moves a resolved decision into the audit section instead of deleting it", () => {
    renderDecisions();
    const pending = screen.getByRole("region", { name: "Pending decisions" });
    const title = "Aicoo wants to use your Research Agent";

    fireEvent.click(within(pending).getByRole("button", { name: "Allow once" }));

    expect(within(pending).queryByRole("heading", { name: title })).toBeNull();
    const resolved = screen.getByRole("region", { name: "Resolved decisions" });
    expect(within(resolved).getByRole("heading", { name: title })).toBeTruthy();
    expect(within(resolved).getByText("Approved")).toBeTruthy();
    expect(document.activeElement).toBe(
      within(pending).getByRole("button", { name: "Run in Cloud" }),
    );
  });
});
