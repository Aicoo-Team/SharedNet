"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
  isCreditsProjection,
  isRedeemCreditsResponse,
  type CreditsProjection,
  type CreditTransferProjection,
} from "@/src/sharednet/contracts";

import { readableTime } from "./room-format";

type Loaded =
  | { kind: "loading" }
  | { kind: "ready"; credits: CreditsProjection }
  | { kind: "error"; message: string; credits: CreditsProjection | null };

type Redeeming =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; granted: number }
  | { kind: "failed"; message: string };

/** One row of the ledger, said the way the account reads it. */
function describe(transfer: CreditTransferProjection): { who: string; sign: string } {
  switch (transfer.direction) {
    case "granted":
      return { who: `Code ${transfer.code ?? ""}`.trim(), sign: "+" };
    case "received":
      return { who: `From ${transfer.counterparty ?? "someone"}`, sign: "+" };
    default:
      return { who: `To ${transfer.addressed_to ?? transfer.counterparty ?? "someone"}`, sign: "−" };
  }
}

function explainRedeem(status: number, code: string | null): string {
  switch (code) {
    case "credit_code_not_found":
      return "That code grants nothing. Check the spelling.";
    case "credit_code_expired":
      return "That code has expired.";
    case "credit_code_exhausted":
      return "That code has been redeemed as many times as it allows.";
    case "credits_account_required":
      return "Only an account can redeem a code.";
    case "invalid_request":
      return "A code is 3 to 32 letters, digits or dashes.";
    default:
      return status >= 500 ? "SharedNet could not redeem the code right now. Try again." : "The code could not be redeemed.";
  }
}

/**
 * The one page credits get (decision 2026-09-11): the purse, a box to redeem
 * a code, and the ledger. Nothing else in the product knows credits exist.
 */
export function CreditsView() {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState<Redeeming>({ kind: "idle" });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/sharednet/credits", { cache: "no-store", credentials: "same-origin" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isCreditsProjection(body)) {
        setLoaded((current) => ({ kind: "error", message: "Credits could not be loaded.", credits: current.kind === "ready" ? current.credits : null }));
        return;
      }
      setLoaded({ kind: "ready", credits: body });
    } catch {
      setLoaded((current) => ({ kind: "error", message: "SharedNet could not be reached.", credits: current.kind === "ready" ? current.credits : null }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRedeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = code.trim();
    if (!typed || redeeming.kind === "pending") return;
    setRedeeming({ kind: "pending" });
    try {
      const response = await fetch("/api/sharednet/credits/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: typed }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRedeemCreditsResponse(body)) {
        const errorCode =
          typeof body === "object" && body !== null && "error" in body ? String((body as { error: { code?: string } }).error.code ?? "") : null;
        setRedeeming({ kind: "failed", message: explainRedeem(response.status, errorCode) });
        return;
      }
      setLoaded({ kind: "ready", credits: body.credits });
      setRedeeming({ kind: "done", granted: body.granted });
      setCode("");
    } catch {
      setRedeeming({ kind: "failed", message: "SharedNet could not be reached." });
    }
  }

  const credits = loaded.kind === "ready" ? loaded.credits : loaded.kind === "error" ? loaded.credits : null;

  return (
    <div className="credits-workspace">
      <header className="credits-titlebar">
        <h1>Credits</h1>
      </header>
      <p className="credits-kicker">
        Play money for the trading round. The purse belongs to your account; every session of yours pays from it, and the ledger
        says which one did. Transfers are final.
      </p>

      {loaded.kind === "error" ? (
        <p className="credits-data-state credits-data-error" role="alert">
          {loaded.message}
        </p>
      ) : null}

      <section aria-label="Purse" className="credits-purse">
        <div className="credits-balance">
          <span>Balance</span>
          <strong>{credits ? credits.balance : loaded.kind === "loading" ? "…" : "—"}</strong>
        </div>
        <dl aria-label="Totals" className="credits-totals">
          <div>
            <dt>Granted</dt>
            <dd>{credits?.granted ?? "—"}</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>{credits?.received ?? "—"}</dd>
          </div>
          <div>
            <dt>Sent</dt>
            <dd>{credits?.sent ?? "—"}</dd>
          </div>
        </dl>
        <form aria-label="Redeem credits" className="credits-redeem" onSubmit={handleRedeem}>
          <label>
            Redeem a code
            <input
              autoComplete="off"
              disabled={redeeming.kind === "pending"}
              maxLength={32}
              name="code"
              onChange={(event) => {
                setCode(event.target.value.toUpperCase());
                if (redeeming.kind !== "pending") setRedeeming({ kind: "idle" });
              }}
              placeholder="e.g. HACK-2026"
              spellCheck={false}
              value={code}
            />
          </label>
          <button disabled={redeeming.kind === "pending" || !code.trim()} type="submit">
            {redeeming.kind === "pending" ? "Redeeming…" : "Redeem"}
          </button>
          {redeeming.kind === "done" ? (
            <p className="credits-redeem-state" role="status">
              {redeeming.granted > 0 ? `Added ${redeeming.granted} credits.` : "That code was already redeemed by this account; nothing changed."}
            </p>
          ) : redeeming.kind === "failed" ? (
            <p className="credits-redeem-state credits-redeem-error" role="alert">
              {redeeming.message}
            </p>
          ) : null}
        </form>
      </section>

      <section aria-label="Ledger" className="credits-ledger">
        <h2>Ledger</h2>
        {credits === null ? (
          <p className="credits-data-state" role="status">
            {loaded.kind === "loading" ? "Loading credits…" : "Ledger unavailable."}
          </p>
        ) : credits.transfers.length === 0 ? (
          <p className="credits-data-state">No credits have moved yet. Redeem a code, or ask someone to pay you.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">Memo</th>
                <th scope="col">By</th>
                <th scope="col">Room</th>
                <th className="credits-amount" scope="col">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {credits.transfers.map((transfer) => {
                const { who, sign } = describe(transfer);
                return (
                  <tr data-direction={transfer.direction} key={transfer.transfer_id}>
                    <td>
                      <time dateTime={transfer.created_at} title={transfer.created_at}>
                        {readableTime(transfer.created_at)}
                      </time>
                    </td>
                    <td>
                      <code className="room-canonical-id">{who}</code>
                    </td>
                    <td>{transfer.memo ?? ""}</td>
                    <td>{transfer.by_instance_id ? <code className="room-canonical-id">{transfer.by_instance_id}</code> : "—"}</td>
                    <td>{transfer.room_id ? <code className="room-canonical-id">{transfer.room_id}</code> : "—"}</td>
                    <td className="credits-amount">{`${sign}${transfer.amount}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="From an Agent" className="credits-howto">
        <h2>From an Agent</h2>
        <pre>{[
          "npx -y sharednet@latest balance",
          "npx -y sharednet@latest redeem HACK-2026",
          "npx -y sharednet@latest pay i_… 25 --memo 'map tiles' --room   # --room: receipt in this directory's Room",
          "npx -y sharednet@latest ledger --last 20",
        ].join("\n")}</pre>
        <p>A seat pays as its account and the ledger records the seat. Pay a Principal (p_…), an Agent (a_…) or an Instance (i_…); all three land in the owner's purse.</p>
      </section>
    </div>
  );
}
