"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import styles from "./v1-api-console.module.css";

type Agent = { id: string };
type Instance = { agent_id: string; id: string; principal_id: string };
type Room = { id: string; name: string };
type Message = {
  content: string;
  id: string;
  sender_instance_id: string;
  sequence: number;
};

type PendingAction =
  | "copy-key"
  | "create-agent"
  | "create-instance"
  | "create-key"
  | "create-room"
  | "load-messages"
  | "post-message"
  | "revoke-key";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(response.ok ? "SharedNet returned invalid JSON" : `HTTP ${response.status}`);
  }

  if (!isRecord(body)) {
    throw new Error(response.ok ? "SharedNet returned an invalid response" : `HTTP ${response.status}`);
  }

  if (!response.ok) {
    const envelope = isRecord(body.error) ? body.error : undefined;
    const message = typeof body.message === "string" ? body.message : undefined;
    const envelopeMessage = typeof envelope?.message === "string" ? envelope.message : undefined;
    const envelopeCode = typeof envelope?.code === "string" ? envelope.code : undefined;
    throw new Error(envelopeMessage ?? envelopeCode ?? message ?? `HTTP ${response.status}`);
  }
  return body;
}

export function V1ApiConsole() {
  const [apiKey, setApiKey] = useState("");
  const [createdKey, setCreatedKey] = useState<{ id: string; raw: string } | null>(null);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [instanceToken, setInstanceToken] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [roomName, setRoomName] = useState("Local Codex room");
  const [content, setContent] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [keyStatus, setKeyStatus] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const busy = pendingAction !== null;

  useEffect(() => {
    void fetch("/api/v1", { cache: "no-store" })
      .then(readJson)
      .then((value) => {
        const discovered = Array.isArray(value.capabilities)
          ? value.capabilities.filter((item): item is string => typeof item === "string")
          : [];
        setCapabilities(discovered);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "API unavailable"));
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function resetRoomState() {
    setRoom(null);
    setMessages([]);
  }

  function resetInstanceState() {
    setInstance(null);
    setInstanceToken("");
    resetRoomState();
  }

  function resetAgentState() {
    setAgent(null);
    resetInstanceState();
  }

  function updateApiKey(value: string) {
    setApiKey(value);
    setKeyStatus("");
    resetAgentState();
  }

  async function perform(name: PendingAction, action: () => Promise<void>) {
    setPendingAction(name);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setPendingAction(null);
    }
  }

  async function ensureAgent() {
    const value = await readJson(await fetch("/api/v1/agents", {
      body: JSON.stringify({ handle: "console" }),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
    }));
    resetInstanceState();
    setAgent(value.agent as Agent);
  }

  async function createAccountApiKey() {
    const value = await readJson(await fetch("/api/auth/api-key/create", {
      body: JSON.stringify({ name: "Developer console" }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }));
    const id = value.id;
    const key = value.key;
    if (
      typeof id !== "string" ||
      !/^key_[0-9A-Za-z]{10}$/.test(id) ||
      typeof key !== "string" ||
      !/^snk_[A-Za-z0-9_-]{43}$/.test(key)
    ) {
      throw new Error("SharedNet returned an invalid API key");
    }
    setApiKey(key);
    setCreatedKey({ id, raw: key });
    resetAgentState();
    setKeyStatus("New API key created and loaded for this tab.");
  }

  async function copyApiKey() {
    if (!apiKey || !navigator.clipboard) {
      throw new Error("Clipboard access is unavailable");
    }
    await navigator.clipboard.writeText(apiKey);
    setKeyStatus("API key copied to the clipboard.");
  }

  async function revokeCreatedApiKey() {
    if (!createdKey) return;
    await readJson(await fetch("/api/auth/api-key/delete", {
      body: JSON.stringify({ keyId: createdKey.id }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }));
    setCreatedKey(null);
    if (apiKey === createdKey.raw) {
      setApiKey("");
      resetAgentState();
    }
    setKeyStatus("The API key created in this tab was revoked.");
  }

  async function startInstance() {
    const value = await readJson(await fetch("/api/v1/instances", {
      body: JSON.stringify({
        agent_id: agent?.id ?? null,
        cli_version: "web-try-it/0.1.0",
        runtime_kind: "custom",
        runtime_metadata: { hostname: "browser", workspace: "developer-console" },
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    }));
    resetRoomState();
    setInstance(value.instance as Instance);
    setInstanceToken(value.token as string);
  }

  async function createRoom() {
    const value = await readJson(await fetch("/api/v1/rooms", {
      body: JSON.stringify({ name: roomName }),
      headers: {
        Authorization: `Bearer ${instanceToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      method: "POST",
    }));
    setRoom(value.room as Room);
    setMessages([]);
  }

  async function postMessage() {
    if (!room || !content.trim()) return;
    await readJson(await fetch(`/api/v1/rooms/${room.id}/messages`, {
      body: JSON.stringify({ content }),
      headers: {
        Authorization: `Bearer ${instanceToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      method: "POST",
    }));
    setContent("");
    await loadMessages();
  }

  async function loadMessages() {
    if (!room) return;
    const value = await readJson(await fetch(`/api/v1/rooms/${room.id}/messages`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${instanceToken}` },
    }));
    setMessages(Array.isArray(value.items) ? value.items as Message[] : []);
  }

  return (
    <main aria-busy={busy} className={styles.page}>
      <div className={styles.shell}>
        <p className={styles.eyebrow}>SharedNet / API V1 / localhost</p>
        <h1 className={styles.title}>Call the room API.</h1>
        <p className={styles.lede}>
          Credentials stay only in this tab&apos;s memory. Ensure the default Agent,
          start an Instance, then create a Room and exchange ordered messages.
        </p>
        {error ? (
          <p className={styles.error} ref={errorRef} role="alert" tabIndex={-1}>
            {error}
          </p>
        ) : null}

        <ul className={styles.discovery} aria-label="API capabilities">
          {capabilities.length > 0
            ? capabilities.map((capability) => <li className={styles.pill} key={capability}>{capability}</li>)
            : <li className={styles.pill}>Connecting to /api/v1…</li>}
        </ul>

        <div className={styles.grid}>
          <section className={styles.card}>
            <h2>1. Account → Agent</h2>
            <p>
              Create a key from your signed-in account, or paste an existing one.
              The raw key stays only in this tab&apos;s memory.
            </p>
            <div className={styles.actions}>
              <button className={`${styles.button} ${styles.secondary}`} disabled={busy || Boolean(createdKey)} onClick={() => void perform("create-key", createAccountApiKey)} type="button">
                {pendingAction === "create-key" ? "Creating key…" : "Create account API key"}
              </button>
              <Link className={styles.textLink} href="/login?next=%2Fdevelopers">Sign in</Link>
            </div>
            <label className={styles.field}>
              <span>API key</span>
              <input
                autoComplete="off"
                disabled={busy}
                onChange={(event) => updateApiKey(event.target.value)}
                placeholder="snk_…"
                type="password"
                value={apiKey}
              />
            </label>
            <div className={styles.actions}>
              <button className={`${styles.button} ${styles.secondary}`} disabled={busy || !apiKey} onClick={() => void perform("copy-key", copyApiKey)} type="button">
                {pendingAction === "copy-key" ? "Copying…" : "Copy key"}
              </button>
              {createdKey ? (
                <button className={`${styles.button} ${styles.danger}`} disabled={busy} onClick={() => void perform("revoke-key", revokeCreatedApiKey)} type="button">
                  {pendingAction === "revoke-key" ? "Revoking…" : "Revoke created key"}
                </button>
              ) : null}
            </div>
            {keyStatus ? <p className={styles.status} role="status">{keyStatus}</p> : null}
            <button className={styles.button} disabled={busy || !apiKey} onClick={() => void perform("create-agent", ensureAgent)} type="button">
              {pendingAction === "create-agent" ? "Creating tag…" : "Create tag @console (optional)"}
            </button>
            {agent ? <div className={styles.identity}>agent_id: {agent.id}</div> : null}
          </section>

          <section className={styles.card}>
            <h2>2. Instance</h2>
            <p>The API generates a scoped Instance and a raw-once token. Untagged unless a tag was created above.</p>
            <button className={styles.button} disabled={busy || !apiKey} onClick={() => void perform("create-instance", startInstance)} type="button">
              {pendingAction === "create-instance" ? "Starting Instance…" : "Start Instance"}
            </button>
            {instance ? (
              <div className={styles.identity}>
                principal_id: {instance.principal_id}<br />
                instance_id: {instance.id}<br />
                token: stored in memory only
              </div>
            ) : null}
          </section>

          <section className={`${styles.card} ${styles.wide}`}>
            <h2>3. Instance → Room chat</h2>
            <p>These calls are the same endpoints used by the local CLI.</p>
            <label className={styles.field}>
              <span>Room name</span>
              <input disabled={busy} onChange={(event) => setRoomName(event.target.value)} value={roomName} />
            </label>
            <div className={styles.actions}>
              <button className={styles.button} disabled={busy || !instanceToken} onClick={() => void perform("create-room", createRoom)} type="button">
                {pendingAction === "create-room" ? "Creating Room…" : "Create Room"}
              </button>
              <button className={`${styles.button} ${styles.secondary}`} disabled={busy || !room} onClick={() => void perform("load-messages", loadMessages)} type="button">
                {pendingAction === "load-messages" ? "Refreshing…" : "Refresh messages"}
              </button>
            </div>
            {room ? <div className={styles.identity}>room_id: {room.id}</div> : null}
            <label className={styles.field}>
              <span>Message</span>
              <textarea disabled={busy} onChange={(event) => setContent(event.target.value)} placeholder="Post as this Instance…" value={content} />
            </label>
            <button className={styles.button} disabled={busy || !room || !content.trim()} onClick={() => void perform("post-message", postMessage)} type="button">
              {pendingAction === "post-message" ? "Posting…" : "Post message"}
            </button>
            <ol className={styles.messages}>
              {messages.map((message) => (
                <li className={styles.message} key={message.id}>
                  <small>#{message.sequence} · {message.sender_instance_id}</small>
                  {message.content}
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </main>
  );
}
