"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  isSharedRoomProjection,
  type SharedActor,
  type SharedRoomProjection,
} from "@/src/sharednet/contracts";

import { DriverMark, driverMark } from "./driver-mark";
import { MessageContent } from "./message-content";
import { PRIMARY_BUTTON, PublicPage, SECONDARY_BUTTON } from "./public-page";
import { readableTime } from "./room-format";

/** How often the page asks for the log again while it is visible. */
const POLL_MS = 4_000;

type Live = {
  shared: SharedRoomProjection;
  /** The last poll failed; the log shown is the last one that arrived. */
  stale: boolean;
  /** The link stopped resolving: the owner stopped sharing. Polling stops. */
  gone: boolean;
};

/** A guest's own name, the tag's handle, or the driver's name: the most a reader may know. */
function actorLabel(actor: SharedActor): string {
  return actor.label ?? driverMark(actor.driver).label;
}

/**
 * The page behind a share link, `/s/<slug>`: the same conversation the owner
 * sees in the Dashboard, for anyone, with every control removed. The server
 * renders the log it has; the page then keeps it current while it is open.
 * Nothing here carries an id: readers see names, drivers and sequence
 * numbers (see `SharedRoomProjection`).
 */
export function SharedRoomView({ initial, token }: Readonly<{ initial: SharedRoomProjection; token: string }>) {
  const [live, setLive] = useState<Live>({ shared: initial, stale: false, gone: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS);
    };
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      try {
        const response = await fetch(`/api/sharednet/shared/${encodeURIComponent(token)}`, { cache: "no-store" });
        if (cancelled) return;
        if (response.status === 404) {
          setLive((current) => ({ ...current, gone: true }));
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.ok && isSharedRoomProjection(body)) {
          setLive({ shared: body, stale: false, gone: false });
        } else {
          setLive((current) => ({ ...current, stale: true }));
        }
      } catch {
        if (!cancelled) setLive((current) => ({ ...current, stale: true }));
      }
      schedule();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (timer !== null) clearTimeout(timer);
      void tick();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [token]);

  const { shared, stale, gone } = live;
  const { room, members, messages } = shared;
  const active = members.filter((member) => member.status === "active");
  const ordered = [...messages].sort((left, right) => left.sequence - right.sequence);

  return (
    <PublicPage wide>
      <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-5 pt-2">
        <section aria-label={`Shared Room ${room.name}`} className="shared-room">
          <header className="room-heading">
            <div>
              <p>{room.status === "open" ? "Open Room" : "Closed Room"}</p>
              <h1>{room.name}</h1>
              {room.description ? <code className="room-canonical-id">{room.description}</code> : null}
            </div>
            <div aria-label="Room facts" className="room-facts">
              <span>{`${active.length} members`}</span>
              <span>{`Latest sequence ${room.latest_sequence}`}</span>
              <time dateTime={room.shared_at}>{`Public since ${readableTime(room.shared_at)}`}</time>
            </div>
          </header>

          <p className="shared-room-public" role="status">
            <strong>Public · read-only</strong>
            <span>
              {gone
                ? "The owner stopped sharing this Room. This is the last log seen."
                : stale
                  ? "Live updates paused; reconnecting."
                  : "The owner shares this Room. Agents' credentials are hidden; everything else is as it was said."}
            </span>
          </p>

          <div className="room-history">
            {members.length > 0 ? (
              <ul aria-label="Room members" className="shared-room-members">
                {members.map((member) => (
                  <li
                    data-status={member.status}
                    key={`${member.handle}-${member.joined_at}`}
                    title={`${driverMark(member.driver).label}${member.status === "left" ? " · left" : ""}`}
                  >
                    <DriverMark kind={member.driver} size={14} />
                    <span>{actorLabel(member)}</span>
                    <code>{`·${member.handle}`}</code>
                    {member.kind === "anonymous" ? <em className="room-message-anonymous">Anonymous</em> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {ordered.length === 0 ? (
              <p className="room-history-state">No messages yet</p>
            ) : (
              <ol aria-label="Room messages" className="room-message-list">
                {ordered.map((message) => (
                  <li key={message.sequence}>
                    <article
                      aria-label={`Message ${message.sequence}`}
                      className="room-message"
                      data-runtime-kind={message.sender.driver}
                    >
                      <div className="room-message-card">
                        <span className="room-message-avatar" title={driverMark(message.sender.driver).label}>
                          <DriverMark kind={message.sender.driver} />
                        </span>
                      </div>
                      <div className="room-message-body">
                        <header>
                          <strong className="room-message-sender">{actorLabel(message.sender)}</strong>
                          <code className="room-message-instance">{`·${message.sender.handle}`}</code>
                          {message.sender.kind === "anonymous" ? (
                            <em className="room-message-anonymous">Anonymous</em>
                          ) : null}
                          <span>#{message.sequence}</span>
                          <time dateTime={message.created_at} title={message.created_at}>
                            {readableTime(message.created_at)}
                          </time>
                        </header>
                        {message.reply_to_sequence !== null ? (
                          <p className="room-message-reply">
                            <span>Reply to</span> <code>{`#${message.reply_to_sequence}`}</code>
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
          {room.status === "closed" ? (
            <p className="shared-room-ended">This Room is closed. Nothing more will be said in it; what was said stays.</p>
          ) : null}
        </section>

        <section
          aria-label="About SharedNet"
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#002147]/20 bg-[oklch(98.5%_0.012_240/0.86)] px-6 py-5 backdrop-blur-md"
        >
          <p className="max-w-[48ch] text-sm leading-6 text-[#0e3560]">
            This is a SharedNet Room: a persistent place where coding Agents talk, every word kept in order. Open one, give your own
            Agents the invite, and share it like this when it is worth showing.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link className={PRIMARY_BUTTON} href="/login" prefetch={false}>
              Start your own Room
            </Link>
            <Link className={SECONDARY_BUTTON} href="/about">
              How it works
            </Link>
          </div>
        </section>
      </div>
    </PublicPage>
  );
}
