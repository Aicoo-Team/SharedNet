import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreditsProjection, InstanceId, PrincipalId, RoomId } from "@/src/sharednet/contracts";

import { CreditsView } from "./credits-view";

const PRINCIPAL_ID = "p_7CPHtWFsFn" as PrincipalId;
const OTHER_PRINCIPAL_ID = "p_V80npHhNlU" as PrincipalId;
const INSTANCE_ID = "i_xQqH1Bafyt" as InstanceId;
const ROOM_ID = "rom_pdSbphCbzG" as RoomId;
const NOW = "2026-09-12T10:00:00.000Z";

const credits: CreditsProjection = {
  balance: 70,
  granted: 100,
  principal_id: PRINCIPAL_ID,
  received: 0,
  sent: 30,
  transfers: [
    {
      addressed_to: INSTANCE_ID,
      amount: 30,
      by_instance_id: INSTANCE_ID,
      code: null,
      counterparty: OTHER_PRINCIPAL_ID,
      created_at: NOW,
      direction: "sent",
      memo: "map tiles",
      room_id: ROOM_ID,
      transfer_id: "txn_AbCdEfGhIj",
    },
    {
      addressed_to: null,
      amount: 100,
      by_instance_id: null,
      code: "HACK-2026",
      counterparty: null,
      created_at: NOW,
      direction: "granted",
      memo: null,
      room_id: null,
      transfer_id: "txn_KlMnOpQrSt",
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("the one page credits get", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input) === "/api/sharednet/credits" ? jsonResponse(credits) : jsonResponse({ error: { code: "route_not_found" } }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the purse and the ledger as the account reads it, with a sign per direction", async () => {
    render(<CreditsView />);

    await waitFor(() => expect(screen.getByText("70")).toBeVisible());
    const totals = screen.getByLabelText("Totals");
    expect(totals).toHaveTextContent("Granted100");
    expect(totals).toHaveTextContent("Sent30");

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent(`To ${INSTANCE_ID}`);
    expect(rows[0]).toHaveTextContent("map tiles");
    expect(rows[0]).toHaveTextContent("−30");
    expect(rows[0]).toHaveTextContent(ROOM_ID);
    expect(rows[1]).toHaveTextContent("Code HACK-2026");
    expect(rows[1]).toHaveTextContent("+100");
  });

  it("redeems a code, says what it added, and says plainly when a repeat adds nothing", async () => {
    render(<CreditsView />);
    await waitFor(() => expect(screen.getByText("70")).toBeVisible());

    fetchMock.mockImplementationOnce(() => jsonResponse({ credits: { ...credits, balance: 170, granted: 200 }, granted: 100 }));
    fireEvent.change(screen.getByLabelText("Redeem a code"), { target: { value: "hack-2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Redeem" }));

    await waitFor(() => expect(screen.getByText("Added 100 credits.")).toBeVisible());
    const [, redeemCall] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(String((redeemCall as RequestInit).body))).toEqual({ code: "HACK-2026" });
    expect(screen.getByText("170")).toBeVisible();

    fetchMock.mockImplementationOnce(() => jsonResponse({ credits: { ...credits, balance: 170, granted: 200 }, granted: 0 }));
    fireEvent.change(screen.getByLabelText("Redeem a code"), { target: { value: "hack-2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Redeem" }));
    await waitFor(() =>
      expect(screen.getByText("That code was already redeemed by this account; nothing changed.")).toBeVisible(),
    );
  });

  it("says why a code was refused, in the domain's own terms, and keeps the purse on screen", async () => {
    render(<CreditsView />);
    await waitFor(() => expect(screen.getByText("70")).toBeVisible());

    fetchMock.mockImplementationOnce(() => jsonResponse({ error: { code: "credit_code_exhausted" } }, 410));
    fireEvent.change(screen.getByLabelText("Redeem a code"), { target: { value: "SPENT" } });
    fireEvent.click(screen.getByRole("button", { name: "Redeem" }));

    await waitFor(() =>
      expect(screen.getByText("That code has been redeemed as many times as it allows.")).toBeVisible(),
    );
    expect(screen.getByText("70")).toBeVisible();
  });

  it("reports credits unavailable rather than showing a purse it does not have", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: { code: "principal_not_found" } }, 404));
    render(<CreditsView />);

    await waitFor(() => expect(screen.getByText("Credits could not be loaded.")).toBeVisible());
    expect(screen.getByText("Ledger unavailable.")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
