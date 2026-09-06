"use client";

import { useEffect, useState } from "react";

import { isCliLoginProjection, type CliLoginProjection } from "@/src/sharednet/contracts";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; login: CliLoginProjection }
  | { kind: "approving"; login: CliLoginProjection }
  | { kind: "approved"; login: CliLoginProjection }
  | { kind: "error"; message: string };

async function requestLogin(path: string, init?: RequestInit): Promise<CliLoginProjection> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: { code?: string } }).error.code ?? "")
        : "";
    const message =
      code === "login_not_found"
        ? "No pending login has that code. Check the terminal and try again."
        : code === "login_expired"
          ? "That login has expired. Run sharednet login again."
          : code === "login_consumed"
            ? "That login was already approved."
            : "SharedNet could not load the login.";
    throw new Error(message);
  }
  if (!isCliLoginProjection(body)) throw new Error("SharedNet returned an invalid login.");
  return body;
}

/**
 * The page a human lands on from `sharednet login`: the code the terminal
 * showed, where the CLI runs, the seats approval would bind, and one button.
 */
export function CliAuthorizeView({ initialCode }: Readonly<{ initialCode: string }>) {
  const [code, setCode] = useState(initialCode);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function load(value: string) {
    if (!value.trim()) return;
    setStatus({ kind: "loading" });
    try {
      const login = await requestLogin(`/api/sharednet/cli/logins/${encodeURIComponent(value.trim())}`);
      setStatus({ kind: "ready", login });
    } catch (cause) {
      setStatus({ kind: "error", message: cause instanceof Error ? cause.message : "Could not load the login." });
    }
  }

  useEffect(() => {
    if (initialCode) void load(initialCode);
    // The initial code comes from the URL once; later lookups go through the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  async function approve(login: CliLoginProjection) {
    setStatus({ kind: "approving", login });
    try {
      const approved = await requestLogin(`/api/sharednet/cli/logins/${encodeURIComponent(code.trim())}/approve`, {
        method: "POST",
      });
      setStatus({ kind: "approved", login: approved });
    } catch (cause) {
      setStatus({ kind: "error", message: cause instanceof Error ? cause.message : "Could not approve the login." });
    }
  }

  const login = "login" in status ? status.login : null;

  return (
    <main className="cli-authorize">
      <h1>Authorize a CLI</h1>
      <p className="cli-authorize-lede">
        A terminal ran <code>sharednet login</code> and showed a code. Approving hands that terminal an
        API key for this account, and binds any seats it already holds in Rooms to you.
      </p>

      <form
        className="cli-authorize-code"
        onSubmit={(event) => {
          event.preventDefault();
          void load(code);
        }}
      >
        <label>
          Code from the terminal
          <input
            autoCapitalize="characters"
            autoComplete="off"
            name="code"
            onChange={(event) => setCode(event.target.value)}
            placeholder="ABCD-EFGH"
            spellCheck={false}
            value={code}
          />
        </label>
        <button disabled={status.kind === "loading"} type="submit">
          {status.kind === "loading" ? "Looking up…" : "Look up"}
        </button>
      </form>

      {status.kind === "error" ? (
        <p className="cli-authorize-error" role="alert">
          {status.message}
        </p>
      ) : null}

      {login ? (
        <section aria-label="Pending login" className="cli-authorize-login">
          <dl>
            <div>
              <dt>Where</dt>
              <dd>{login.label ?? "a terminal that gave no name"}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>
                <time dateTime={login.expires_at}>{login.expires_at}</time>
              </dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{login.state}</dd>
            </div>
          </dl>
          <h2>Seats this terminal holds</h2>
          {login.seats.length === 0 ? (
            <p>None. The terminal has not joined a Room as a guest; nothing is bound.</p>
          ) : (
            <ul aria-label="Seats to bind">
              {login.seats.map((seat) => (
                <li key={seat.instance_id}>
                  <strong>{seat.name ?? seat.instance_id}</strong> · {seat.runtime_kind}
                  {seat.rooms.length > 0 ? ` · in ${seat.rooms.map((room) => room.name).join(", ")}` : ""}
                  <code className="room-canonical-id">{seat.instance_id}</code>
                </li>
              ))}
            </ul>
          )}
          {status.kind === "approved" ? (
            <p className="cli-authorize-done" role="status">
              Approved. Return to the terminal; it has the key now.
            </p>
          ) : login.state === "pending" ? (
            <button
              className="cli-authorize-approve"
              disabled={status.kind === "approving"}
              onClick={() => void approve(login)}
              type="button"
            >
              {status.kind === "approving" ? "Approving…" : "Approve this terminal"}
            </button>
          ) : (
            <p role="status">This login is {login.state}; nothing to approve.</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
