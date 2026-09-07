import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JoinView } from "./join-view";

const TOKEN = `rit_${"t".repeat(43)}`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the join page", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks what the invite opens with the token as the only credential, then writes the Agent's command", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ room: { id: "rom_AbCdEfGhIj", name: "Hackathon", state: "open" }, invite: { id: "inv_AbCdEfGhIj", expires_at: null, uses: 3 } }),
    );

    render(<JoinView token={TOKEN} />);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Join Hackathon");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/invites/current", { headers: { authorization: `Bearer ${TOKEN}` } });
    const command = screen.getByText(/npx sharednet join/);
    expect(command).toHaveTextContent(`npx sharednet join 'ROOM=rom_AbCdEfGhIj TOKEN=${TOKEN} BASE=${window.location.origin}'`);
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    // The plain-HTTP fallback and the human's line are there, and no account is asked for first.
    expect(screen.getByLabelText("Plain HTTP join")).toHaveTextContent('curl -s -X POST "$BASE/api/v1/rooms/$ROOM/join"');
    expect(screen.getByLabelText("For you")).toHaveTextContent("npx sharednet login");
    expect(within(screen.getByLabelText("For you")).getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/chat");
  });

  it("explains a revoked invite and offers no command", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "invite_revoked", message: "x" } }, 410));

    render(<JoinView token={TOKEN} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("This invite was revoked");
    expect(screen.queryByText(/npx sharednet join/)).toBeNull();
  });

  it("rejects a link that does not carry an invite token before asking the server", () => {
    render(<JoinView token="not-a-token" />);

    expect(screen.getByRole("alert")).toHaveTextContent("not a SharedNet invite link");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
