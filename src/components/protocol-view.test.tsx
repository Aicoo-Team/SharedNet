import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProtocolView } from "./protocol-view";

describe("SharedNet Local protocol", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("presents a minimal Room-join surface with the Agent instruction first", () => {
    const { container } = render(<ProtocolView origin="https://sharednet.ai" />);

    expect(
      screen.getByRole("heading", { name: "Join this Agent to a Room." }),
    ).toBeTruthy();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/wizard/i)).toBeNull();

    expect(
      screen.queryByRole("link", { name: "Download SharedNet Local" }),
    ).toBeNull();
    expect(screen.getByText(/CLI is already available/)).toBeTruthy();
    expect(screen.getByText(/Package distribution comes later/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy instruction for Agent" }),
    ).toHaveClass("protocol-primary-action");
  });

  it("shows login, approval, Agent connect, Room join, and retrieval in order", () => {
    const { container } = render(<ProtocolView origin="https://sharednet.ai" />);
    const pageText = container.textContent ?? "";
    const milestones = [
      "sharednet login",
      "verification_url",
      "approve it in Decisions",
      "sharednet agent connect",
      "sharednet room join ROOM_ID",
      "sharednet room retrieve ROOM_ID",
    ];

    expect(screen.getByLabelText("SharedNet login command")).toHaveTextContent(
      "--account-session ACCOUNT_SESSION",
    );
    expect(screen.getByLabelText("SharedNet Agent connect command")).toHaveTextContent(
      "--runtime-kind RUNTIME_KIND",
    );
    expect(screen.getByLabelText("SharedNet Agent connect command")).toHaveTextContent(
      "--instance-session INSTANCE_SESSION",
    );
    expect(screen.getByLabelText("SharedNet Agent connect command")).toHaveTextContent(
      "--no-local-config",
    );
    expect(screen.getByLabelText("SharedNet Room join command")).toHaveTextContent(
      "--session INSTANCE_SESSION",
    );
    expect(screen.getByLabelText("SharedNet Room retrieve command")).toHaveTextContent(
      "--session INSTANCE_SESSION",
    );

    for (const [index, milestone] of milestones.entries()) {
      expect(pageText.indexOf(milestone), milestone).toBeGreaterThan(-1);
      if (index > 0) {
        expect(pageText.indexOf(milestone), milestone).toBeGreaterThan(
          pageText.indexOf(milestones[index - 1]!),
        );
      }
    }

    expect(pageText).not.toContain("sharednet room register");
    expect(pageText).not.toContain("sharednet room build");
    expect(pageText).not.toContain("sharednet room list");
    expect(pageText).not.toContain("sharednet room post");
    expect(pageText).not.toContain("sharednet local run");
    expect(pageText).not.toContain("--principal-id");
    expect(pageText).not.toContain("--agent-id");
    expect(pageText).toContain("If login returns authorization_required");
  });

  it("uses Instance identity and explains persistent Agent state", () => {
    render(<ProtocolView origin="https://sharednet.ai" />);

    expect(screen.getByText("Principal → Agent → Runtime → Instance")).toBeTruthy();
    expect(screen.queryByText("Principal → Agent → Runtime → Session")).toBeNull();
    expect(screen.getByText("a live conversation or task")).toBeTruthy();
    expect(screen.getByText(/persistent Agent state path/)).toBeTruthy();
    expect(screen.getByText(/fresh Instance session path/)).toBeTruthy();
    expect(screen.getByText(/Web observes Rooms and mutates only Decisions/)).toBeTruthy();
  });

  it("copies the exact Agent instruction while keeping credentials and Room joins constrained", async () => {
    render(<ProtocolView origin="https://sharednet.ai" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy instruction for Agent" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain(
      "Read https://sharednet.ai/skill.md and follow it exactly",
    );
    expect(writeText.mock.calls[0]?.[0]).toContain("exact existing Room ID");
    expect(writeText.mock.calls[0]?.[0]).toContain("Never inspect or expose credential files");
    expect(writeText.mock.calls[0]?.[0]).not.toContain("downloads/sharednet-local");
    expect(writeText.mock.calls[0]?.[0]).not.toContain("sharednet room build");
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("uses the live browser origin when no public deployment URL is configured", async () => {
    render(<ProtocolView origin="" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy instruction for Agent" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain(
      `Read ${window.location.origin}/skill.md`,
    );
  });
});
