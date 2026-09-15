import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SharedRoomProjection } from "@/src/sharednet/contracts";

import { SharedRoomView } from "./shared-room-view";

const SLUG = `shr_${"s".repeat(43)}`;
const NOW = "2026-09-11T02:00:00.000Z";
const EARLIER = "2026-09-11T01:30:00.000Z";

const shared: SharedRoomProjection = {
  members: [
    { driver: "codex", handle: "xQqH", kind: "account", label: "reviewer", joined_at: EARLIER, status: "active" },
    { driver: "claude-code", handle: "GbUH", kind: "anonymous", label: "claude-code", joined_at: EARLIER, status: "active" },
    { driver: "custom", handle: "Left", kind: "account", label: null, joined_at: EARLIER, status: "left" },
  ],
  messages: [
    {
      content: "Verification is complete. Token was rit_[redacted].",
      created_at: NOW,
      reply_to_sequence: 7,
      sender: { driver: "claude-code", handle: "GbUH", kind: "anonymous", label: "claude-code" },
      sequence: 12,
    },
    {
      content: "Please verify the launch checklist.",
      created_at: EARLIER,
      reply_to_sequence: null,
      sender: { driver: "codex", handle: "xQqH", kind: "account", label: "reviewer" },
      sequence: 7,
    },
  ],
  room: {
    created_at: EARLIER,
    description: "Coordinate the production launch",
    latest_sequence: 12,
    name: "Launch readiness",
    shared_at: NOW,
    status: "open",
  },
};

describe("a shared Room, as anyone reads it", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(() => Promise.resolve(Response.json(shared)));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders the log the server handed it, by names and sequence numbers, with no id on the page", () => {
    render(<SharedRoomView initial={shared} token={SLUG} />);

    expect(screen.getByRole("heading", { level: 1, name: "Launch readiness" })).toBeVisible();
    expect(screen.getByText("Public · read-only")).toBeVisible();
    expect(screen.getByText("2 members")).toBeVisible();
    expect(screen.getByText("Latest sequence 12")).toBeVisible();

    const messages = within(screen.getByRole("list", { name: "Room messages" })).getAllByRole("listitem");
    expect(messages.map((item) => item.getAttribute("aria-label") ?? within(item).getByRole("article").getAttribute("aria-label"))).toEqual([
      "Message 7",
      "Message 12",
    ]);
    expect(within(messages[1]!).getByText("Reply to")).toBeVisible();
    expect(within(messages[1]!).getByText("#7")).toBeVisible();
    expect(within(messages[1]!).getByText("Anonymous")).toBeVisible();
    expect(screen.getByText("Verification is complete. Token was rit_[redacted].")).toBeVisible();

    const members = within(screen.getByRole("list", { name: "Room members" })).getAllByRole("listitem");
    expect(members.map((item) => item.getAttribute("data-status"))).toEqual(["active", "active", "left"]);
    expect(within(members[2]!).getByText("Unknown driver")).toBeVisible();

    // Not one Room, Instance, Principal or message id anywhere on the page.
    expect(document.body.textContent).not.toMatch(/\b(rom|i|p|msg)_[0-9A-Za-z]{10}\b/);
    expect(screen.getByRole("link", { name: "Start your own Room" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/chat");
    expect(screen.queryByRole("button", { name: /invite|share|close/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps the log current from the public route while open, and says so when the owner stops sharing", async () => {
    render(<SharedRoomView initial={shared} token={SLUG} />);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...shared,
        messages: [
          ...shared.messages,
          { content: "Shipped.", created_at: NOW, reply_to_sequence: null, sender: shared.messages[1]!.sender, sequence: 13 },
        ],
        room: { ...shared.room, latest_sequence: 13 },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/sharednet/shared/${SLUG}`, { cache: "no-store" });
    expect(screen.getByText("Shipped.")).toBeVisible();
    expect(screen.getByText("Latest sequence 13")).toBeVisible();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "room_not_found" } }), { status: 404 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByText(/The owner stopped sharing this Room/)).toBeVisible();
    expect(screen.getByText("Shipped.")).toBeVisible();
    // Polling stops once the link is dead.
    const calls = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
