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

  it("presents a minimal Agent-first surface with the SharedNet Local download first", () => {
    const { container } = render(<ProtocolView origin="https://sharednet.ai" />);

    expect(
      screen.getByRole("heading", { name: "Connect this Agent." }),
    ).toBeTruthy();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/wizard/i)).toBeNull();

    const download = screen.getByRole("link", { name: "Download SharedNet Local" });
    expect(download).toHaveAttribute("href", "/downloads/sharednet-local");
    expect(download).toHaveClass("protocol-primary-action");
    expect(
      screen.getByRole("button", { name: "Copy instruction for Agent" }),
    ).toBeTruthy();
  });

  it("shows login, exact human approval, Agent connect, and local run in order", () => {
    const { container } = render(<ProtocolView origin="https://sharednet.ai" />);
    const pageText = container.textContent ?? "";
    const milestones = [
      "sharednet login",
      "verification_url",
      "approve it in Decisions",
      "sharednet agent connect",
      "sharednet local run --config .sharednet/local.json",
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

    for (const [index, milestone] of milestones.entries()) {
      expect(pageText.indexOf(milestone), milestone).toBeGreaterThan(-1);
      if (index > 0) {
        expect(pageText.indexOf(milestone), milestone).toBeGreaterThan(
          pageText.indexOf(milestones[index - 1]!),
        );
      }
    }

    expect(pageText).not.toContain("sharednet room register");
    expect(pageText).not.toContain("--principal-id");
    expect(pageText).not.toContain("--agent-id");
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
      "Read https://sharednet.ai/protocol/skill.md and follow it exactly",
    );
    expect(writeText.mock.calls[0]?.[0]).toContain("exact verification_url");
    expect(writeText.mock.calls[0]?.[0]).toContain("fresh Instance session path");
    expect(writeText.mock.calls[0]?.[0]).toContain("Never inspect or expose credential files");
    expect(writeText.mock.calls[0]?.[0]).toContain(
      "join only an exact Room ID I provide",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("uses the live browser origin when no public deployment URL is configured", async () => {
    render(<ProtocolView origin="" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy instruction for Agent" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain(
      `Read ${window.location.origin}/protocol/skill.md`,
    );
  });
});
