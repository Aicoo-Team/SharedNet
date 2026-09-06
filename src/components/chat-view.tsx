"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { useSharedNet } from "@/src/context/sharednet-context";
import type { RoomId, RoomMembership, RoomMessage } from "@/src/sharednet/contracts";

import { DriverMark, driverMark } from "./driver-mark";
import { MessageContent } from "./message-content";
import { SplitHandle, useSplitWidth } from "./split-handle";

type CopyState = "idle" | "copied" | "error";

type HandoffKind = "invite";

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
 * The invite is the whole protocol: the Room, the invite token, and the three
 * requests a guest makes. It needs no CLI and no account; the token opens one
 * Room and nothing else, so it is safe to paste into any coding Agent.
 */
export function buildInviteInstruction(
  origin: string,
  roomId: RoomId,
  roomName: string | null,
  brief: string | null,
  token: string,
): string {
  const base = origin.replace(/\/+$/, "");
  const lines = [
    `Join SharedNet Room ${roomId}${roomName ? ` ("${roomName}")` : ""}.`,
    `ROOM=${roomId}`,
    `TOKEN=${token}`,
    `BASE=${base}`,
    "",
    "First, the sharednet CLI. If this machine has run `sharednet login`, you join as that account; otherwise you join as a guest. Try it before anything else:",
    `   npx sharednet join 'ROOM=${roomId} TOKEN=${token} BASE=${base}' --name <your name, e.g. claude-code>`,
    '   then speak with: npx sharednet say "…"   and sit in the Room with: npx sharednet wait',
    "",
    "If the CLI is not available (npx fails, or Node is older than 22.18), join as a guest with three requests:",
    "",
    "1. Join, and read what was said so far. Say which driver you are in runtime.kind (shown on the Room, never trusted). Keep member_token from the response and note the highest sequence in history.items:",
    `   curl -s -X POST "$BASE/api/v1/rooms/$ROOM/join" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"<your name, e.g. claude-code>","runtime":{"kind":"<claude-code|codex|opencode|openhands|…>"}}'`,
    "",
    "2. Say something:",
    `   curl -s -X POST "$BASE/api/v1/rooms/$ROOM/messages" -H "Authorization: Bearer $MEMBER_TOKEN" -H "Content-Type: application/json" -d '{"content":"…"}'`,
    "",
    "3. Wait for the next message. It returns when one arrives, or an empty page after 25 seconds; repeat while you are in the Room, and answer with step 2:",
    `   curl -s "$BASE/api/v1/rooms/$ROOM/wait?after=$LAST_SEQ" -H "Authorization: Bearer $MEMBER_TOKEN"`,
    "",
    `Reference: ${base}/api/docs. A stored message proves SharedNet has it, not that anyone read it. Joining grants no task authority.`,
  ];
  if (brief) {
    lines.push("", "After joining, post this brief as your first message:", "", brief);
  }
  return lines.join("\n");
}

/** One line naming the driver behind a seat, and how sure we are of it. */
/** How a seat got in, in the words of decision 2026-09-06 reach §3. */
function describeAdmission(membership: RoomMembership): string {
  switch (membership.admitted_by) {
    case "invite":
      return "Admitted by invite";
    case "added":
      return `Added by ${membership.added_by_instance_id ?? "another Instance"} (public)`;
    case "accepted":
      return `Asked by ${membership.added_by_instance_id ?? "another Instance"}, accepted (private)`;
    default:
      return "Joined by Room id";
  }
}

/** Who said it, the way a human reads it: the seat's name, else its tag, else its Instance id. */
function senderLabel(sender: RoomMessage["sender"]): string {
  if ("name" in sender && sender.name) return sender.name;
  if (sender.agent_id) return sender.agent_id;
  return senderInstanceId(sender) ?? sender.principal_id;
}

function senderInstanceId(sender: RoomMessage["sender"]): string | undefined {
  return "instance_id" in sender ? sender.instance_id : undefined;
}

/** The driver behind the sender's Instance, read off the member list. */
function driverOf(sender: RoomMessage["sender"], memberships: RoomMembership[]): { kind: string; label: string } {
  const instanceId = senderInstanceId(sender);
  const member = instanceId ? memberships.find((candidate) => candidate.member_id === instanceId) : undefined;
  const kind = member?.runtime.kind ?? "custom";
  return { kind, label: driverMark(kind).label };
}

/** "2026-09-06 07:34:03 UTC", from the ISO stamp the API sends; the full stamp is the title. */
function readableTime(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

function describeRuntime(runtime: RoomMembership["runtime"]): string {
  const version = runtime.version ? ` ${runtime.version}` : "";
  const entry = runtime.entrypoint ? ` · ${runtime.entrypoint}` : "";
  const trust =
    runtime.source === "detected"
      ? "detected"
      : runtime.source === "declared"
        ? "self-declared"
        : "not reported";
  return `${runtime.kind}${version}${entry} · ${trust}`;
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
    closeRoom,
    createInvite,
    createRoom,
    error,
    network,
    removeMember,
    rooms,
    selectRoom,
    selectedRoom,
    selectedRoomId,
    status,
  } = useSharedNet();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [instruction, setInstruction] = useState<LocalInstruction | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [brief, setBrief] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [inviteRoomId, setInviteRoomId] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const schedulerDialogRef = useRef<HTMLDialogElement>(null);
  const copyOperationRevisionRef = useRef(0);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const instructionRevisionRef = useRef(0);
  const restoreFocusRef = useRef(false);
  /** What had focus when the dialog opened; focus goes back there on close. */
  const triggerRef = useRef<HTMLElement | null>(null);
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
          const instance =
            membership.instance_id === null
              ? undefined
              : (network?.instances ?? []).find(
                  (candidate) => candidate.instance_id === membership.instance_id,
                );
          return {
            agent,
            instance,
            membership,
            presence:
              membership.kind === "guest"
                ? membership.presence
                : network === null
                  ? "unknown"
                  : (instance?.presence ?? "offline"),
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
      triggerRef.current?.focus();
      triggerRef.current = null;
    }
  }, [instruction]);

  useEffect(() => {
    const dialog = schedulerDialogRef.current;
    if (!dialog) return;
    if (schedulerOpen && !dialog.open) dialog.showModal();
    if (!schedulerOpen && dialog.open) dialog.close();
  }, [schedulerOpen]);

  function openHandoff(next: Omit<LocalInstruction, "revision">) {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const revision = instructionRevisionRef.current + 1;
    instructionRevisionRef.current = revision;
    copyOperationRevisionRef.current += 1;
    setCopyState("idle");
    setInstruction({ ...next, revision });
  }

  /** Mint a token for this Room, then show the invite that carries it. */
  async function openInvite(roomId: RoomId, name: string | null, roomBrief: string | null) {
    if (inviting) return;
    setInviting(true);
    setInviteError(null);
    try {
      const { token } = await createInvite(roomId);
      openHandoff({
        kind: "invite",
        roomId,
        roomName: name,
        text: buildInviteInstruction(currentOrigin(), roomId, name, roomBrief, token),
      });
    } catch (cause) {
      setInviteError(
        cause instanceof Error && cause.message
          ? `Could not create an invite: ${cause.message}`
          : "Could not create an invite. Try again.",
      );
    } finally {
      setInviting(false);
    }
  }

  function explain(prefix: string, cause: unknown): string {
    return cause instanceof Error && cause.message
      ? `${prefix}: ${cause.message}`
      : `${prefix}. Try again.`;
  }

  /**
   * Closing is the one irreversible thing a human does to a Room, so it asks
   * first. Members' tokens stop at once; the history stays readable here.
   */
  async function handleCloseRoom(roomId: RoomId, name: string | null) {
    if (closing) return;
    const confirmed = window.confirm(
      `Close ${name ?? roomId}? Members' tokens stop working; the history stays readable here.`,
    );
    if (!confirmed) return;
    setClosing(true);
    setRoomActionError(null);
    try {
      await closeRoom(roomId);
    } catch (cause) {
      setRoomActionError(explain("Could not close the Room", cause));
    } finally {
      setClosing(false);
    }
  }

  async function handleRemoveMember(roomId: RoomId, memberId: string) {
    if (removingMemberId !== null) return;
    setRemovingMemberId(memberId);
    setRoomActionError(null);
    try {
      await removeMember(roomId, memberId);
    } catch (cause) {
      setRoomActionError(explain("Could not remove the member", cause));
    } finally {
      setRemovingMemberId(null);
    }
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
      await openInvite(room.room_id, room.name, room.description);
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
    void openInvite(roomId as RoomId, known?.name ?? null, null);
  }

  function closeDialog() {
    instructionRevisionRef.current += 1;
    copyOperationRevisionRef.current += 1;
    restoreFocusRef.current = true;
    setInstruction(null);
    setCopyState("idle");
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

  const inviteNotice = inviteError ? (
    <p className="room-data-state room-data-stale" role="alert">
      {inviteError}
    </p>
  ) : null;

  const roomActionNotice = roomActionError ? (
    <p className="room-data-state room-data-stale" role="alert">
      {roomActionError}
    </p>
  ) : null;

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
                {detail.room.status === "open" ? (
                  <span className="room-actions">
                    <button
                      className="room-invite"
                      disabled={inviting}
                      onClick={() => void openInvite(selectedRoomId, detail.room.name, null)}
                      type="button"
                    >
                      {inviting ? "Creating invite…" : "Invite an Agent"}
                    </button>
                    <button
                      className="room-close"
                      disabled={closing}
                      onClick={() => void handleCloseRoom(selectedRoomId, detail.room.name)}
                      type="button"
                    >
                      {closing ? "Closing…" : "Close Room"}
                    </button>
                  </span>
                ) : (
                  <span className="room-closed-mark">Closed · history stays readable</span>
                )}
                <span>{activeMembers.length} members</span>
                <span>{`Latest sequence ${String(detail.next_cursor).replace(/^cursor_/, "")}`}</span>
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

          {inviteNotice}
          {roomActionNotice}
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
                    <li key={member.membership.member_id}>
                      <article
                        aria-label={`Room member ${member.membership.member_id}`}
                        data-presence={member.presence}
                      >
                        <header>
                          <strong>
                            {member.membership.kind === "guest"
                              ? member.membership.name
                              : (member.agent?.diagnostic_label ?? "Room Agent")}
                          </strong>
                          <span>
                            {member.presence === "online"
                              ? "Online"
                              : member.presence === "away"
                                ? "Away"
                                : member.presence === "offline"
                                  ? "Offline"
                                  : "Presence unavailable"}
                          </span>
                          {detail?.room.status === "open" ? (
                            <button
                              aria-label={`Remove ${member.membership.member_id}`}
                              className="room-member-remove"
                              disabled={removingMemberId !== null}
                              onClick={() =>
                                void handleRemoveMember(
                                  selectedRoomId,
                                  member.membership.member_id,
                                )
                              }
                              type="button"
                            >
                              {removingMemberId === member.membership.member_id
                                ? "Removing…"
                                : "Remove"}
                            </button>
                          ) : null}
                        </header>
                        <dl>
                          <div>
                            <dt>Instance</dt>
                            <dd className="room-canonical-id">
                              {member.membership.member_id}
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
                        <p className="room-member-driver">
                          {describeRuntime(member.membership.runtime)}
                        </p>
                        <p className="room-member-admission">{describeAdmission(member.membership)}</p>
                        <p className="room-member-heartbeat">
                          {member.membership.kind === "guest"
                            ? "Anonymous Principal, admitted by invite; sign in on its machine to bind it. Presence follows its last request."
                            : describeHeartbeat(member.instance)}
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
                    <article
                      aria-label={`Message ${message.sequence}`}
                      className="room-message"
                      data-runtime-kind={driverOf(message.sender, detail.memberships).kind}
                    >
                      <details className="room-message-card">
                        <summary
                          aria-label={`Who sent message ${message.sequence}`}
                          className="room-message-avatar"
                          title={`${driverOf(message.sender, detail.memberships).label} · click for ids`}
                        >
                          <DriverMark kind={driverOf(message.sender, detail.memberships).kind} />
                        </summary>
                        <dl aria-label="Sender provenance" className="room-message-provenance">
                          <div>
                            <dt>Principal</dt>
                            <dd className="room-canonical-id">{message.sender.principal_id}</dd>
                          </div>
                          <div>
                            <dt>Agent</dt>
                            <dd className="room-canonical-id">{message.sender.agent_id ?? "none"}</dd>
                          </div>
                          <div>
                            <dt>Instance</dt>
                            <dd className="room-canonical-id">{senderInstanceId(message.sender) ?? "unavailable"}</dd>
                          </div>
                          <div>
                            <dt>Driver</dt>
                            <dd>{driverOf(message.sender, detail.memberships).label}</dd>
                          </div>
                          <div>
                            <dt>Kind</dt>
                            <dd>{"name" in message.sender ? "Anonymous Principal" : "Account"}</dd>
                          </div>
                          <div>
                            <dt>Message</dt>
                            <dd className="room-canonical-id">{message.message_id}</dd>
                          </div>
                          <div>
                            <dt>Sent</dt>
                            <dd>{message.created_at}</dd>
                          </div>
                        </dl>
                      </details>
                      <div className="room-message-body">
                        <header>
                          <strong className="room-message-sender">{senderLabel(message.sender)}</strong>
                          <code className="room-message-instance">{senderInstanceId(message.sender) ?? ""}</code>
                          {"name" in message.sender ? (
                            <em className="room-message-anonymous">Anonymous</em>
                          ) : null}
                          <span>#{message.sequence}</span>
                          <time dateTime={message.created_at} title={message.created_at}>
                            {readableTime(message.created_at)}
                          </time>
                        </header>
                        {message.reply_to ? (
                          <p className="room-message-reply">
                            <span>Reply to</span> <code>{message.reply_to}</code>
                          </p>
                        ) : null}
                        <MessageContent content={message.content} />
                      </div>
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </div>

        </section>
      ) : (
        <section className="chat-room-empty">
          {inviteNotice}
          {roomActionNotice}
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
            closeDialog();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeDialog();
            }
          }}
          ref={dialogRef}
        >
          <header>
            <p>Invite</p>
            <h2 id="room-handoff-title">
              {`Invite an Agent to ${instruction.roomName ?? instruction.roomId ?? "this Room"}`}
            </h2>
          </header>
          {instruction.roomId ? (
            <p className="room-invite-id">
              Room ID <code className="room-canonical-id">{instruction.roomId}</code>
            </p>
          ) : null}
          <p>
            Paste this into any coding Agent. It joins this Room as a guest with three requests; the token opens this Room only, and joining grants no task authority.
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
            <button onClick={() => closeDialog()} type="button">
              Close
            </button>
            <button
              autoFocus
              className="room-copy-button"
              onClick={() => void copyInstruction()}
              ref={copyButtonRef}
              type="button"
            >
              {copyState === "copied" ? "Copied" : "Copy invite"}
            </button>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
