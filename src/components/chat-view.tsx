"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { useSharedNet } from "@/src/context/sharednet-context";
import type { RoomId } from "@/src/sharednet/contracts";

type CopyState = "idle" | "copied" | "error";

type LocalInstruction = {
  revision: number;
  text: string;
};

function buildLocalInstruction(draft: string, roomId: RoomId | null): string {
  if (roomId === null) {
    return `Build a SharedNet Room from your local Agent. Use this draft as the initial brief, post it locally as the Room's first plain-text message, and return the new Room ID:\n\n${draft}`;
  }

  return `Use SharedNet Room ${roomId}. Join it if needed, retrieve its current history first, then post this draft locally as a plain-text message from your current local Agent Instance. Return the resulting message ID/cursor:\n\n${draft}`;
}

export function ChatView() {
  const {
    error,
    network,
    rooms,
    selectRoom,
    selectedRoom,
    selectedRoomId,
    status,
  } = useSharedNet();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [draft, setDraft] = useState("");
  const [instruction, setInstruction] = useState<LocalInstruction | null>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const copyOperationRevisionRef = useRef(0);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const instructionRevisionRef = useRef(0);
  const restoreFocusRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
  const activeMembers = useMemo(
    () =>
      (detail?.memberships ?? [])
        .filter((membership) => membership.status === "active")
        .map((membership) => {
          const agent = network?.agents.find(
            (candidate) =>
              candidate.agent_id === membership.agent_id &&
              candidate.principal_id === membership.principal_id,
          );
          const runtimes = (network?.runtimes ?? [])
            .filter(
              (runtime) =>
                runtime.agent_id === membership.agent_id &&
                runtime.principal_id === membership.principal_id,
            )
            .map((runtime) => {
              const instances = (network?.instances ?? []).filter(
                (instance) =>
                  instance.runtime_id === runtime.runtime_id &&
                  instance.agent_id === membership.agent_id &&
                  instance.principal_id === membership.principal_id,
              );
              return {
                instances,
                presence:
                  runtime.status === "active" &&
                  instances.some((instance) => instance.presence === "online")
                    ? "online"
                    : "offline",
                runtime,
              };
            });
          return {
            agent,
            membership,
            presence:
              network === null
                ? "unknown"
                : runtimes.some((runtime) => runtime.presence === "online")
                  ? "online"
                  : "offline",
            runtimes,
          };
        }),
    [detail, network],
  );

  useEffect(() => {
    if (instruction !== null) {
      const dialog = dialogRef.current;
      if (dialog && !dialog.open) dialog.showModal();
      copyButtonRef.current?.focus();
      return;
    }

    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      const continueButton = continueButtonRef.current;
      if (continueButton && !continueButton.disabled) {
        continueButton.focus();
      } else {
        textareaRef.current?.focus();
      }
    }
  }, [instruction]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextDraft = draft.trim();
    if (!nextDraft) return;
    const revision = instructionRevisionRef.current + 1;
    instructionRevisionRef.current = revision;
    copyOperationRevisionRef.current += 1;
    setCopyState("idle");
    setInstruction({
      revision,
      text: buildLocalInstruction(nextDraft, selectedRoomId),
    });
  }

  function closeDialog(clearDraft: boolean) {
    instructionRevisionRef.current += 1;
    copyOperationRevisionRef.current += 1;
    restoreFocusRef.current = true;
    setInstruction(null);
    setCopyState("idle");
    if (clearDraft) setDraft("");
  }

  async function copyInstruction() {
    if (instruction === null) return;
    const instructionAtStart = instruction;
    const operationRevision = copyOperationRevisionRef.current + 1;
    copyOperationRevisionRef.current = operationRevision;
    setCopyState("idle");

    try {
      await navigator.clipboard.writeText(instructionAtStart.text);
      if (
        instructionRevisionRef.current !== instructionAtStart.revision ||
        copyOperationRevisionRef.current !== operationRevision
      ) {
        return;
      }
      setDraft("");
      setCopyState("copied");
    } catch {
      if (
        instructionRevisionRef.current !== instructionAtStart.revision ||
        copyOperationRevisionRef.current !== operationRevision
      ) {
        return;
      }
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
        ref={textareaRef}
        rows={3}
        value={draft}
      />
      <button
        aria-label="Continue locally"
        disabled={!draft.trim()}
        ref={continueButtonRef}
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
    <>
      <div
        className="rooms-workspace"
        inert={instruction !== null ? true : undefined}
      >
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
          ) : status === "stale" ? (
            <p className="rooms-empty-copy" role="status">
              Rooms unavailable while SharedNet data is stale.
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
              <code className="room-canonical-id">{selectedRoomId}</code>
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
            {detail !== null ? (
              <section
                aria-labelledby="active-room-members-title"
                className="room-members"
              >
                <header>
                  <h2 id="active-room-members-title">Active members</h2>
                  <span>{activeMembers.length}</span>
                </header>
                <ul aria-label="Active Room members" className="room-member-list">
                  {activeMembers.map((member) => (
                    <li key={member.membership.agent_id}>
                      <article
                        aria-label={`Room member ${member.membership.agent_id}`}
                        data-presence={member.presence}
                      >
                        <header>
                          <strong>
                            {member.agent?.diagnostic_label ?? "Room Agent"}
                          </strong>
                          <span>
                            {member.presence === "online"
                              ? "Online"
                              : member.presence === "offline"
                                ? "Offline"
                                : "Presence unavailable"}
                          </span>
                        </header>
                        <dl>
                          <div>
                            <dt>Principal</dt>
                            <dd className="room-canonical-id">
                              {member.membership.principal_id}
                            </dd>
                          </div>
                          <div>
                            <dt>Agent</dt>
                            <dd className="room-canonical-id">
                              {member.membership.agent_id}
                            </dd>
                          </div>
                        </dl>
                        {member.presence === "unknown" ? (
                          <p>Runtime and Instance presence is unavailable.</p>
                        ) : member.runtimes.length === 0 ? (
                          <p>No Runtime or Instance presence is projected.</p>
                        ) : (
                          <ul
                            aria-label={`Runtime presence for ${member.membership.agent_id}`}
                            className="room-runtime-list"
                          >
                            {member.runtimes.map((runtime) => (
                              <li
                                data-presence={runtime.presence}
                                key={runtime.runtime.runtime_id}
                              >
                                <span>Runtime</span>
                                <code className="room-canonical-id">
                                  {runtime.runtime.runtime_id}
                                </code>
                                <small>
                                  {runtime.presence === "online"
                                    ? "Online · active Instance lease"
                                    : "Offline · no active Instance lease"}
                                </small>
                                {runtime.instances.length > 0 ? (
                                  <ul
                                    aria-label={`Instances for ${runtime.runtime.runtime_id}`}
                                    className="room-instance-list"
                                  >
                                    {runtime.instances.map((instance) => (
                                      <li
                                        data-presence={instance.presence}
                                        key={instance.instance_id}
                                      >
                                        <span>Instance</span>
                                        <code className="room-canonical-id">
                                          {instance.instance_id}
                                        </code>
                                        <small>
                                          {instance.presence === "online"
                                            ? "Online · lease active"
                                            : "Offline · lease expired or ended"}
                                        </small>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p>No Instances projected.</p>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {detail === null ? (
              <p className="room-history-state" role="status">
                {status === "stale"
                  ? "Room history unavailable while SharedNet data is stale."
                  : "Loading Room history…"}
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
                          <dd className="room-canonical-id">
                            {message.sender.principal_id}
                          </dd>
                        </div>
                        <div>
                          <dt>Agent</dt>
                          <dd className="room-canonical-id">
                            {message.sender.agent_id}
                          </dd>
                        </div>
                        <div>
                          <dt>Runtime</dt>
                          <dd className="room-canonical-id">
                            {message.sender.runtime_id}
                          </dd>
                        </div>
                        <div>
                          <dt>Instance</dt>
                          <dd className="room-canonical-id">
                            {message.sender.instance_id ?? "Unavailable"}
                          </dd>
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
      </div>

      {instruction !== null ? (
        <dialog
          aria-labelledby="room-handoff-title"
          aria-modal="true"
          className="room-handoff-dialog"
          onCancel={(event) => {
            event.preventDefault();
            closeDialog(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeDialog(false);
            }
          }}
          ref={dialogRef}
        >
          <header>
            <p>Read-only handoff</p>
            <h2 id="room-handoff-title">Continue in SharedNet Local</h2>
          </header>
          <p>
            Copy these instructions to a local Agent. Nothing has been submitted
            from this browser.
          </p>
          <pre aria-label="Local Agent instructions">{instruction.text}</pre>
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
              autoFocus
              className="room-copy-button"
              onClick={() => void copyInstruction()}
              ref={copyButtonRef}
              type="button"
            >
              {copyState === "copied" ? "Copied" : "Copy instructions"}
            </button>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
