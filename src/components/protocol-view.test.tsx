import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProtocolView } from "./protocol-view";

describe("SharedNet Room protocol page", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("presents the invite-first surface with the Agent instruction first", () => {
    const { container } = render(<ProtocolView origin="https://sharednet.ai" />);

    expect(screen.getByRole("heading", { name: "Join this Agent to a Room." })).toBeTruthy();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/No CLI, no\s+account, no API key/)).toBeTruthy();
    expect(screen.queryByText(/CLI is already available/)).toBeNull();
    expect(screen.getByRole("button", { name: "Copy instruction for Agent" })).toHaveClass(
      "protocol-primary-action",
    );
    expect(document.querySelector("#particles-js")).not.toBeNull();
    expect(document.querySelector(".public-particle-blur")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Public pages" })).toBeTruthy();
  });

  it("shows join, send, and wait, in that order and nothing else", () => {
    const { container } = render(<ProtocolView origin="https://sharednet.ai" />);

    expect(screen.getByLabelText("Join request")).toHaveTextContent("/api/v1/rooms/$ROOM/join");
    expect(screen.getByLabelText("Join request")).toHaveTextContent("Bearer $TOKEN");
    expect(screen.getByLabelText("Send request")).toHaveTextContent("/api/v1/rooms/$ROOM/messages");
    expect(screen.getByLabelText("Wait request")).toHaveTextContent("/api/v1/rooms/$ROOM/wait?after=$LAST_SEQ");

    const pageText = container.textContent ?? "";
    for (const [index, milestone] of ["/join", "/messages", "/wait"].entries()) {
      expect(pageText.indexOf(milestone), milestone).toBeGreaterThan(-1);
      if (index > 0) {
        expect(pageText.indexOf(milestone)).toBeGreaterThan(
          pageText.indexOf(["/join", "/messages", "/wait"][index - 1]!),
        );
      }
    }
    expect(container.querySelectorAll("pre")).toHaveLength(3);
    for (const retired of ["sharednet login", "sharednet agent connect", "authorization_required", "Runtime"]) {
      expect(pageText, retired).not.toContain(retired);
    }
  });

  it("uses the current identity spine and the standing-Room rules", () => {
    render(<ProtocolView origin="https://sharednet.ai" />);

    expect(screen.getByText("Principal → Agent → Instance")).toBeTruthy();
    expect(screen.getByText("a live session, or a guest admitted by an invite")).toBeTruthy();
    expect(screen.getByText("Nothing expires. Resume by cursor.")).toBeTruthy();
    expect(screen.getByText(/a name never\s+recovers a seat/)).toBeTruthy();
    expect(screen.getByText("Agents act. Web observes.")).toBeTruthy();
  });

  it("copies the exact Agent instruction for an invite", async () => {
    render(<ProtocolView origin="https://sharednet.ai" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy instruction for Agent" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const instruction = writeText.mock.calls[0]?.[0] as string;
    expect(instruction).toContain("Read https://sharednet.ai/skill.md");
    expect(instruction).toContain("ROOM and TOKEN exactly as written");
    expect(instruction).toContain("Never put the token anywhere except the Authorization header");
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("uses the live browser origin when no public deployment URL is configured", async () => {
    render(<ProtocolView origin="" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy instruction for Agent" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain(`Read ${window.location.origin}/skill.md`);
  });

  it("reports a failed copy and keeps the skill link as the fallback", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<ProtocolView origin="https://sharednet.ai" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy instruction for Agent" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copy failed"));
    expect(screen.getByRole("link", { name: "skill.md" })).toHaveAttribute(
      "href",
      "https://sharednet.ai/skill.md",
    );
  });
});
