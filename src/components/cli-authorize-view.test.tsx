import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliAuthorizeView } from "./cli-authorize-view";

const pendingLogin = {
  login_id: "cli_AbCdEfGhIj",
  state: "pending",
  label: "laptop",
  expires_at: "2026-09-06T10:10:00.000Z",
  approved_at: null,
  seats: [
    {
      instance_id: "i_guest00001",
      name: "claude-code",
      runtime_kind: "claude-code",
      rooms: [{ room_id: "rom_AbCdEfGhIj", name: "Demo" }],
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the CLI authorize page", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("looks up the code from the URL, shows where the terminal runs and the seats it holds, and approves", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(pendingLogin))
      .mockResolvedValueOnce(jsonResponse({ ...pendingLogin, state: "approved", approved_at: "2026-09-06T10:01:00.000Z" }));

    render(<CliAuthorizeView initialCode="ABCD-EFGH" />);

    const panel = await screen.findByRole("region", { name: "Pending login" });
    expect(fetchMock).toHaveBeenCalledWith("/api/sharednet/cli/logins/ABCD-EFGH", expect.objectContaining({ credentials: "same-origin" }));
    expect(within(panel).getByText("laptop")).toBeVisible();
    const seats = within(panel).getByRole("list", { name: "Seats to bind" });
    expect(within(seats).getByText("claude-code")).toBeVisible();
    expect(within(seats).getByText(/in Demo/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Approve this terminal" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/sharednet/cli/logins/ABCD-EFGH/approve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Approved. Return to the terminal");
    expect(screen.queryByRole("button", { name: "Approve this terminal" })).toBeNull();
  });

  it("explains an unknown or expired code and offers nothing to approve", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "login_expired", message: "x" } }, 410));

    render(<CliAuthorizeView initialCode="ABCD-EFGH" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("That login has expired");
    expect(screen.queryByRole("button", { name: "Approve this terminal" })).toBeNull();
  });

  it("takes a code typed by hand when the URL carried none", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...pendingLogin, seats: [] }));

    render(<CliAuthorizeView initialCode="" />);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Code from the terminal"), { target: { value: "abcd-efgh" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));

    const panel = await screen.findByRole("region", { name: "Pending login" });
    expect(fetchMock).toHaveBeenCalledWith("/api/sharednet/cli/logins/abcd-efgh", expect.anything());
    expect(within(panel).getByText(/nothing is bound/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve this terminal" })).toBeVisible();
  });
});
