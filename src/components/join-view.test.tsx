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

  it("asks what the invite opens, mints a claim for the signed-in account, and writes the Agent's command with it", async () => {
    const CLAIM = `clp_${"c".repeat(43)}`;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ room: { id: "rom_AbCdEfGhIj", name: "Hackathon", state: "open" }, invite: { id: "inv_AbCdEfGhIj", expires_at: null, uses: 3 } }),
      )
      .mockResolvedValueOnce(jsonResponse({ claim: CLAIM, login_id: "cli_AbCdEfGhIj", expires_at: "2026-09-14T00:00:00.000Z", principal_id: "p_AbCdEfGhIj" }));

    render(<JoinView token={TOKEN} />);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Join Hackathon");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/invites/current", { headers: { authorization: `Bearer ${TOKEN}` } });
    const command = await screen.findByText(/--claim/);
    expect(command).toHaveTextContent(`npx sharednet join 'ROOM=rom_AbCdEfGhIj TOKEN=${TOKEN} BASE=${window.location.origin}' --claim ${CLAIM}`);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/sharednet/cli/claims", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    // The plain invite and the three requests stay for an Agent that is not the viewer's.
    expect(screen.getByLabelText("Plain HTTP join")).toHaveTextContent('curl -s -X POST "$BASE/api/v1/rooms/$ROOM/join"');
    expect(screen.getByLabelText("For you")).toHaveTextContent("npx sharednet login");
    expect(within(screen.getByLabelText("For you")).getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/chat");
  });

  it("falls back to the plain command, and says so, when no claim could be minted", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ room: { id: "rom_AbCdEfGhIj", name: "Hackathon", state: "open" }, invite: { id: "inv_AbCdEfGhIj", expires_at: null, uses: 3 } }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: { code: "authentication_required" } }, 401));

    render(<JoinView token={TOKEN} />);

    expect(await screen.findByText(/could not be minted/)).toBeVisible();
    const commands = screen.getAllByText(/npx sharednet join/, { selector: "code" });
    expect(commands.every((node) => !node.textContent?.includes("--claim"))).toBe(true);
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
