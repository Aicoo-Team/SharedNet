import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SharedNetDemoProvider } from "@/src/context/sharednet-demo-context";
import { ChatView } from "./chat-view";

function renderChat() {
  return render(
    <SharedNetDemoProvider>
      <ChatView />
    </SharedNetDemoProvider>,
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
    expect(screen.getByRole("link", { name: "Review 2 decisions" })).toHaveAttribute(
      "href",
      "/decisions",
    );
    expect(screen.getByText("36.6k tokens")).toBeTruthy();
    expect(screen.getByText("$0.21")).toBeTruthy();
  });
});
