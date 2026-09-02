"use client";

import { type FormEvent, useMemo, useState } from "react";

import { useSharedNet } from "@/src/context/sharednet-context";
import type { RoomId } from "@/src/sharednet/contracts";

type CopyState = "idle" | "copied" | "error";

function buildLocalInstruction(draft: string, roomId: RoomId | null): string {
  if (roomId === null) {
    return `Build a SharedNet Room from your local Agent. Use this draft as the initial brief, post it locally as the Room's first plain-text message, and return the new Room ID:\n\n${draft}`;
  }

  return `Use SharedNet Room ${roomId}. Join it if needed, retrieve its current history first, then post this draft locally as a plain-text message from your current local Agent Instance. Return the resulting message ID/cursor:\n\n${draft}`;
}

export function ChatView() {
  const {
    error,
    rooms,
    selectRoom,
    selectedRoom,
    selectedRoomId,
    status,
  } = useSharedNet();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [draft, setDraft] = useState("");
  const [instruction, setInstruction] = useState<string | null>(null);
  const selectedSummary = rooms.find((room) => room.room_id === selectedRoomId);
  const detail =
    selectedRoom?.room.room_id === selectedRoomId ? selectedRoom : null;
  const orderedMessages = useMemo(
    () =>
      [...(detail?.messages ?? [])].sort(
        (left, right) => left.sequence - right.sequence,
      ),
    [detail],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextDraft = draft.trim();
    if (!nextDraft) return;
    setCopyState("idle");
    setInstruction(buildLocalInstruction(nextDraft, selectedRoomId));
  }

  function closeDialog(clearDraft: boolean) {
    setInstruction(null);
    setCopyState("idle");
    if (clearDraft) setDraft("");
  }

  async function copyInstruction() {
    if (instruction === null) return;
    setCopyState("idle");

    try {
      await navigator.clipboard.writeText(instruction);
      setDraft("");
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  const composer = (
    <form className="room-composer" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor="room-draft">
        What do you want done?
      </label>
      <textarea
        id="room-draft"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Type here…"
        rows={3}
        value={draft}
      />
      <button
        aria-label="Continue locally"
        disabled={!draft.trim()}
        type="submit"
      >
        <span aria-hidden="true">↑</span>
      </button>
    </form>
  );

  const staleNotice = status === "stale" ? (
    <p className="room-data-state room-data-stale" role="alert">
      {error ?? "SharedNet data may be out of date."}
    </p>
  ) : null;

  return (
    <div className="rooms-workspace">
      <aside className="rooms-sidebar">
        <p>Rooms</p>
        <nav aria-label="Rooms">
          {rooms.length > 0 ? (
            rooms.map((room) => (
              <button
                aria-current={room.room_id === selectedRoomId ? "true" : undefined}
                aria-label={`Open room ${room.name}`}
                key={room.room_id}
                onClick={() => selectRoom(room.room_id)}
                type="button"
              >
                <strong>{room.name}</strong>
                <span className="room-summary-line">
                  <span>{room.status}</span>
                  <span>Sequence {room.latest_sequence}</span>
                </span>
                <time dateTime={room.updated_at}>{room.updated_at}</time>
              </button>
            ))
          ) : status === "loading" ? (
            <p className="rooms-empty-copy" role="status">
              Loading rooms…
            </p>
          ) : (
            <p className="rooms-empty-copy">No rooms yet</p>
          )}
        </nav>
      </aside>

      {selectedRoomId !== null ? (
        <section className="room-canvas" aria-live="polite">
          <header className="room-heading">
            <div>
              <p>{detail?.room.status ?? selectedSummary?.status ?? "Room"}</p>
              <h1>{detail?.room.name ?? selectedSummary?.name ?? "Room"}</h1>
              <code>{selectedRoomId}</code>
            </div>
            {detail ? (
              <div className="room-facts" aria-label="Room facts">
                <span>
                  {selectedSummary?.member_count ??
                    detail.memberships.filter(
                      (membership) => membership.status === "active",
                    ).length} members
                </span>
                <span>{`Latest cursor ${detail.next_cursor}`}</span>
                <time
                  dateTime={selectedSummary?.updated_at ?? detail.room.updated_at}
                >
                  {selectedSummary?.updated_at ?? detail.room.updated_at}
                </time>
              </div>
            ) : null}
          </header>

          {staleNotice}

          <div className="room-history">
            {detail === null ? (
              <p className="room-history-state" role="status">
                Loading Room history…
              </p>
            ) : orderedMessages.length === 0 ? (
              <p className="room-history-state">No messages yet</p>
            ) : (
              <ol aria-label="Room messages" className="room-message-list">
                {orderedMessages.map((message) => (
                  <li key={message.message_id}>
                    <article aria-label={`Message ${message.sequence}`}>
                      <header>
                        <span>Sequence {message.sequence}</span>
                        <code>{message.message_id}</code>
                        <time dateTime={message.created_at}>{message.created_at}</time>
                      </header>
                      {message.reply_to ? (
                        <p className="room-message-reply">
                          <span>Reply to</span> <code>{message.reply_to}</code>
                        </p>
                      ) : null}
                      <p className="room-message-content">{message.content}</p>
                      <dl
                        aria-label="Sender provenance"
                        className="room-message-provenance"
                      >
                        <div>
                          <dt>Principal</dt>
                          <dd>{message.sender.principal_id}</dd>
                        </div>
                        <div>
                          <dt>Agent</dt>
                          <dd>{message.sender.agent_id}</dd>
                        </div>
                        <div>
                          <dt>Runtime</dt>
                          <dd>{message.sender.runtime_id}</dd>
                        </div>
                        <div>
                          <dt>Instance</dt>
                          <dd>{message.sender.instance_id ?? "Unavailable"}</dd>
                        </div>
                      </dl>
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <footer className="room-composer-dock">{composer}</footer>
        </section>
      ) : (
        <section className="chat-room-empty">
          {staleNotice}
          {composer}
        </section>
      )}

      {instruction !== null ? (
        <div className="room-handoff-backdrop">
          <section
            aria-labelledby="room-handoff-title"
            aria-modal="true"
            className="room-handoff-dialog"
            role="dialog"
          >
            <header>
              <p>Read-only handoff</p>
              <h2 id="room-handoff-title">Continue in SharedNet Local</h2>
            </header>
            <p>
              Copy these instructions to a local Agent. Nothing has been submitted
              from this browser.
            </p>
            <pre aria-label="Local Agent instructions">{instruction}</pre>
            {copyState === "copied" ? (
              <p className="room-copy-state room-copy-success" role="status">
                Copied to clipboard.
              </p>
            ) : copyState === "error" ? (
              <p className="room-copy-state room-copy-error" role="alert">
                Clipboard access failed. Copy the instructions manually.
              </p>
            ) : null}
            <div className="room-handoff-actions">
              <button onClick={() => closeDialog(false)} type="button">
                Close
              </button>
              <button onClick={() => closeDialog(true)} type="button">
                Close and clear
              </button>
              <button
                className="room-copy-button"
                onClick={() => void copyInstruction()}
                type="button"
              >
                {copyState === "copied" ? "Copied" : "Copy instructions"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
