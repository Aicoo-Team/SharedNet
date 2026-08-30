import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SharedNetDemoProvider,
  useSharedNetDemo,
} from "@/src/context/sharednet-demo-context";
import { ChatView } from "./chat-view";

function renderChat() {
  return render(
    <SharedNetDemoProvider>
      <ChatView />
    </SharedNetDemoProvider>,
  );
}

function ResolvedTaskHarness() {
  const { state, resolveDecision } = useSharedNetDemo();
  return (
    <>
      <ChatView />
      <button
        type="button"
        onClick={() => {
          const taskId = state.tasks.at(-1)?.id;
          state.decisions
            .filter((decision) => decision.taskId === taskId)
            .forEach((decision) => resolveDecision(decision.id, "approved"));
        }}
      >
        Resolve launch decisions
      </button>
    </>
  );
}

describe("SharedNet Chat", () => {
  beforeEach(() => window.localStorage.clear());

  it("starts with one quiet typing surface instead of a staged questionnaire", () => {
    renderChat();

    expect(screen.getByRole("heading", { name: "What do you want done?" })).toBeTruthy();
    expect(screen.getByLabelText("What do you want done?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try a website launch" })).toBeTruthy();
    expect(screen.getByText(/canonical website-launch flow/i)).toBeTruthy();
    expect(screen.queryByText("Shape the product")).toBeNull();
    expect(screen.queryByText("Requirement readiness")).toBeNull();
  });

  it("plans and forms a mixed-Principal organization inside the conversation", () => {
    renderChat();
    fireEvent.change(screen.getByLabelText("What do you want done?"), {
      target: {
        value: "Build and launch a customer feedback website with Neon and Vercel.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    expect(
      screen.getByRole("heading", { name: "I’ll organize this as one launch task." }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Candidate world formed" })).toBeTruthy();
    expect(screen.getAllByText("@aicoo/web-builder").length).toBeGreaterThan(0);
    expect(screen.getAllByText("@xisen/codex").length).toBeGreaterThan(0);
    const workLedger = screen.getByRole("region", { name: "Agent work ledger" });
    expect(within(workLedger).getByText("@aicoo/neon")).toBeTruthy();
    expect(within(workLedger).getByText("Database schema and migration plan")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review 2 decisions" })).toHaveAttribute(
      "href",
      "/decisions",
    );
    expect(screen.getByText("36.6k tokens")).toBeTruthy();
    expect(screen.getByText("$0.21")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Build and launch a customer feedback website with Neon and Vercel.",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Continue the task")).toBeNull();
  });

  it("derives result copy and the decision action from current authority state", () => {
    render(
      <SharedNetDemoProvider>
        <ResolvedTaskHarness />
      </SharedNetDemoProvider>,
    );
    fireEvent.change(screen.getByLabelText("What do you want done?"), {
      target: { value: "Build a website" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));
    fireEvent.click(screen.getByRole("button", { name: "Resolve launch decisions" }));

    expect(screen.queryByRole("link", { name: "Review 2 decisions" })).toBeNull();
    expect(screen.getByRole("link", { name: "View decision audit" })).toHaveAttribute(
      "href",
      "/decisions",
    );
    expect(screen.getByText(/all authority decisions for this task are resolved/i)).toBeTruthy();
  });
});
