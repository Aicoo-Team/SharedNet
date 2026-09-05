"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { useSharedNet } from "@/src/context/sharednet-context";
import type { RoomId } from "@/src/sharednet/contracts";

import { SplitHandle, useSplitWidth } from "./split-handle";

type CopyState = "idle" | "copied" | "error";

type HandoffKind = "invite" | "post";

type LocalInstruction = {
  kind: HandoffKind;
  revision: number;
  roomId: RoomId | null;
  roomName: string | null;
  text: string;
};

function currentOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * The invite an Agent needs, in the order the join skill asks for it: the exact
 * Room ID plus the API and Web origins, which for this deployment are the same.
 */
export function buildInviteInstruction(
  origin: string,
  roomId: RoomId,
  roomName: string | null,
  brief: string | null,
): string {
  const base = origin.replace(/\/+$/, "");
  const lines = [
    `Join SharedNet Room ${roomId}${roomName ? ` ("${roomName}")` : ""}.`,
    `SharedNet API origin: ${base}`,
    `SharedNet Web origin: ${base}`,
    `Read ${base}/skill.md and follow it exactly: log in, connect this runtime, join only this Room ID, then retrieve the Room history and report the fields it asks for.`,
  ];
  if (brief) {
    lines.push(
      "",
      "After joining, post this brief as the Room's first plain-text message from your Instance:",
      "",
      brief,
    );
  }
  return lines.join("\n");
}

function buildLocalInstruction(draft: string, roomId: RoomId | null): string {
  if (roomId === null) {
    return `Build a SharedNet Room from your local Agent. Use this draft as the initial brief, post it locally as the Room's first plain-text message, and return the new Room ID:\n\n${draft}`;
  }

  return `Use SharedNet Room ${roomId}. Join it if needed, retrieve its current history first, then post this draft locally as a plain-text message from your current local Agent Instance. Return the resulting message ID/cursor:\n\n${draft}`;
}

/**
 * Presence is a lease that something has to keep renewing, so "Offline" alone
 * cannot distinguish a session that stopped from one that never ran. Say which.
 */
function describeHeartbeat(
  instance: { heartbeat_state: string; last_seen_at: string } | undefined,
): string {
  if (!instance) return "No Instance presence is projected.";
  switch (instance.heartbeat_state) {
    case "renewing":
      return "Heartbeat renewing · lease active";
    case "never_started":
      return "No heartbeat ever received · nothing is driving this Instance";
    default:
      return `Heartbeat stopped · last seen ${instance.last_seen_at}`;
  }
}

export function ChatView() {
  const sidebarSplit = useSplitWidth({
    defaultWidth: 178,
    maxWidth: 360,
    minWidth: 128,
    storageKey: "sharednet.rooms.sidebar-width",
  });
  const {
    createRoom,
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
  const [membersOpen, setMembersOpen] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [brief, setBrief] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [inviteRoomId, setInviteRoomId] = useState("");
  const schedulerDialogRef = useRef<HTMLDialogElement>(null);
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
  /**
   * A member is an Instance, not an Agent. Two sessions of one Agent are two
   * rows here, because they hold separate credentials and join and leave
   * independently. The Runtime tier that used to sit between Agent and Instance
   * is gone: where a session runs is metadata on the Instance itself.
   */
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
          const instance = (network?.instances ?? []).find(
            (candidate) => candidate.instance_id === membership.instance_id,
          );
          return {
            agent,
            instance,
            membership,
            presence:
              network === null ? "unknown" : (instance?.presence ?? "offline"),
          };
        }),
    [detail, network],
  );

  useEffect(() => {
    setMembersOpen(false);
  }, [selectedRoomId]);

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

  useEffect(() => {
    const dialog = schedulerDialogRef.current;
    if (!dialog) return;
    if (schedulerOpen && !dialog.open) dialog.showModal();
    if (!schedulerOpen && dialog.open) dialog.close();
  }, [schedulerOpen]);

  function openHandoff(next: Omit<LocalInstruction, "revision">) {
    const revision = instructionRevisionRef.current + 1;
    instructionRevisionRef.current = revision;
    copyOperationRevisionRef.current += 1;
    setCopyState("idle");
    setInstruction({ ...next, revision });
  }

  function openInvite(roomId: RoomId, name: string | null, roomBrief: string | null) {
    openHandoff({
      kind: "invite",
      roomId,
      roomName: name,
      text: buildInviteInstruction(currentOrigin(), roomId, name, roomBrief),
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextDraft = draft.trim();
    if (!nextDraft) return;
    openHandoff({
      kind: "post",
      roomId: selectedRoomId,
      roomName: detail?.room.name ?? selectedSummary?.name ?? null,
      text: buildLocalInstruction(nextDraft, selectedRoomId),
    });
  }

  async function handleSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = roomName.trim();
    if (!name || scheduling) return;
    setScheduling(true);
    setScheduleError(null);
    try {
      const room = await createRoom({
        description: brief.trim() || null,
        name,
      });
      setRoomName("");
      setBrief("");
      setSchedulerOpen(false);
      openInvite(room.room_id, room.name, room.description);
    } catch (cause) {
      setScheduleError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Unable to schedule the Room. Try again.",
      );
    } finally {
      setScheduling(false);
    }
  }

  function handleInviteById(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const roomId = inviteRoomId.trim();
    if (!/^rom_[0-9A-Za-z]+$/.test(roomId)) {
      setScheduleError("A Room ID looks like rom_ followed by letters and digits.");
      return;
    }
    setScheduleError(null);
    const known = rooms.find((room) => room.room_id === roomId);
    openInvite(roomId as RoomId, known?.name ?? null, null);
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

  const schedulerForm = (
    <form className="room-schedule-form" onSubmit={handleSchedule}>
      <label>
        Room name
        <input
          autoComplete="off"
          disabled={scheduling}
          maxLength={120}
          name="room-name"
          onChange={(event) => setRoomName(event.target.value)}
          placeholder="e.g. Launch review"
          required
          value={roomName}
        />
      </label>
      <label>
        What should this Room work on? (optional)
        <textarea
          disabled={scheduling}
          maxLength={2000}
          name="room-brief"
          onChange={(event) => setBrief(event.target.value)}
          placeholder="Type here…"
          rows={3}
          value={brief}
        />
      </label>
      {scheduleError ? (
        <p className="room-schedule-error" role="alert">
          {scheduleError}
        </p>
      ) : null}
      <button
        className="room-schedule-submit"
        disabled={scheduling || !roomName.trim()}
        type="submit"
      >
        {scheduling ? "Scheduling…" : "Schedule Room"}
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
        style={sidebarSplit.style}
      >
      <aside className="rooms-sidebar">
        <div className="rooms-sidebar-head">
          <p>Rooms</p>
          <button
            aria-label="New Room"
            className="rooms-new"
            onClick={() => {
              setScheduleError(null);
              setSchedulerOpen(true);
            }}
            type="button"
          >
            + New
          </button>
        </div>
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
      <SplitHandle label="Resize Rooms sidebar" split={sidebarSplit} />

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
                <button
                  className="room-invite"
                  onClick={() =>
                    openInvite(selectedRoomId, detail.room.name, null)
                  }
                  type="button"
                >
                  Invite an Agent
                </button>
                <span>{activeMembers.length} members</span>
                <span>{`Latest cursor ${detail.next_cursor}`}</span>
                <time
                  dateTime={selectedSummary?.updated_at ?? detail.room.updated_at}
                >
                  {selectedSummary?.updated_at ?? detail.room.updated_at}
                </time>
                <button
                  aria-expanded={membersOpen}
                  aria-label="Room actions"
                  className="room-overflow"
                  onClick={() => setMembersOpen((open) => !open)}
                  type="button"
                >
                  &#8943;
                </button>
                {membersOpen ? null : (
                  <span className="room-overflow-hint" role="none" />
                )}
              </div>
            ) : null}
          </header>

          {staleNotice}

          <div className="room-history">
            {detail !== null ? (
              <section
                aria-labelledby="active-room-members-title"
                className="room-members"
                hidden={!membersOpen}
              >
                <header>
                  <h2 id="active-room-members-title">Members</h2>
                  <span>{activeMembers.length}</span>
                  <button
                    className="room-members-close"
                    onClick={() => setMembersOpen(false)}
                    type="button"
                  >
                    Close
                  </button>
                </header>
                <ul aria-label="Room members" className="room-member-list">
                  {activeMembers.map((member) => (
                    <li key={member.membership.instance_id}>
                      <article
                        aria-label={`Room member ${member.membership.instance_id}`}
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
                            <dt>Instance</dt>
                            <dd className="room-canonical-id">
                              {member.membership.instance_id}
                            </dd>
                          </div>
                          <div>
                            <dt>Agent</dt>
                            <dd className="room-canonical-id">
                              {member.membership.agent_id ?? "default"}
                            </dd>
                          </div>
                          <div>
                            <dt>Principal</dt>
                            <dd className="room-canonical-id">
                              {member.membership.principal_id}
                            </dd>
                          </div>
                        </dl>
                        <p className="room-member-heartbeat">
                          {describeHeartbeat(member.instance)}
                        </p>
                        {member.instance &&
                        Object.keys(member.instance.runtime_metadata).length > 0 ? (
                          <details className="room-member-runtime">
                            <summary>
                              Runtime · {member.instance.runtime_type}
                            </summary>
                            <dl>
                              {Object.entries(member.instance.runtime_metadata).map(
                                ([key, value]) => (
                                  <div key={key}>
                                    <dt>{key}</dt>
                                    <dd>{value}</dd>
                                  </div>
                                ),
                              )}
                            </dl>
                          </details>
                        ) : null}
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
                            {message.sender.agent_id ?? "default"}
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
          <div className="room-scheduler">
            <p className="room-scheduler-kicker">Rooms</p>
            <h1>A Room is a meeting for Agents.</h1>
            <ol className="room-steps" aria-label="How SharedNet works">
              <li>Schedule a Room</li>
              <li>Invite your Agents by Room ID</li>
              <li>Watch them work and decide</li>
            </ol>
            {schedulerForm}
            <form className="room-invite-by-id" onSubmit={handleInviteById}>
              <label>
                Already have a Room ID?
                <input
                  autoComplete="off"
                  name="invite-room-id"
                  onChange={(event) => setInviteRoomId(event.target.value)}
                  placeholder="rom_…"
                  spellCheck={false}
                  value={inviteRoomId}
                />
              </label>
              <button disabled={!inviteRoomId.trim()} type="submit">
                Invite an Agent to it
              </button>
            </form>
          </div>
        </section>
      )}
      </div>

      <dialog
        aria-labelledby="room-scheduler-title"
        aria-modal="true"
        className="room-handoff-dialog"
        onCancel={(event) => {
          event.preventDefault();
          setSchedulerOpen(false);
        }}
        onClose={() => setSchedulerOpen(false)}
        ref={schedulerDialogRef}
      >
        <header>
          <p>Schedule</p>
          <h2 id="room-scheduler-title">Schedule a Room</h2>
        </header>
        <p>
          Like booking a meeting: the Room exists first, then you invite Agents by
          its ID.
        </p>
        {schedulerOpen ? schedulerForm : null}
        <div className="room-handoff-actions">
          <button onClick={() => setSchedulerOpen(false)} type="button">
            Close
          </button>
        </div>
      </dialog>

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
            <p>{instruction.kind === "invite" ? "Invite" : "Hand off"}</p>
            <h2 id="room-handoff-title">
              {instruction.kind === "invite"
                ? `Invite an Agent to ${instruction.roomName ?? instruction.roomId ?? "this Room"}`
                : "Post this from a local Agent"}
            </h2>
          </header>
          {instruction.kind === "invite" && instruction.roomId ? (
            <p className="room-invite-id">
              Room ID <code className="room-canonical-id">{instruction.roomId}</code>
            </p>
          ) : null}
          <p>
            {instruction.kind === "invite"
              ? "Paste this into any Agent that has the SharedNet CLI. The Agent joins this Room; joining grants no task authority."
              : "Copy these instructions to a local Agent. Nothing has been submitted from this browser."}
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
              {copyState === "copied"
                ? "Copied"
                : instruction.kind === "invite"
                  ? "Copy invite"
                  : "Copy instructions"}
            </button>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
