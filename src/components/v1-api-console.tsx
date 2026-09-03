"use client";

import { useEffect, useState } from "react";
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

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const envelope = body.error as { code?: string; message?: string } | undefined;
    throw new Error(envelope?.code ?? envelope?.message ?? `HTTP ${response.status}`);
  }
  return body;
}

export function V1ApiConsole() {
  const [apiKey, setApiKey] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [instanceToken, setInstanceToken] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [roomName, setRoomName] = useState("Local Codex room");
  const [content, setContent] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/v1", { cache: "no-store" })
      .then(readJson)
      .then((value) => setCapabilities(value.capabilities as string[] ?? []))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "API unavailable"));
  }, []);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function ensureAgent() {
    const value = await readJson(await fetch("/api/v1/agents/default", {
      headers: { Authorization: `Bearer ${apiKey}` },
      method: "PUT",
    }));
    setAgent(value.agent as Agent);
  }

  async function startInstance() {
    if (!agent) return;
    const value = await readJson(await fetch(`/api/v1/agents/${agent.id}/instances`, {
      body: JSON.stringify({ cli_version: "web-try-it/0.1.0", runtime_kind: "custom" }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    }));
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
    setMessages(value.items as Message[]);
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <p className={styles.eyebrow}>SharedNet / API V1 / localhost</p>
        <h1 className={styles.title}>Call the room API.</h1>
        <p className={styles.lede}>
          Credentials stay only in this tab&apos;s memory. Ensure the default Agent,
          start an Instance, then create a Room and exchange ordered messages.
        </p>

        <div className={styles.discovery} aria-label="API capabilities">
          {capabilities.length > 0
            ? capabilities.map((capability) => <span className={styles.pill} key={capability}>{capability}</span>)
            : <span className={styles.pill}>Connecting to /api/v1…</span>}
        </div>

        <div className={styles.grid}>
          <section className={styles.card}>
            <h2>1. Account → Agent</h2>
            <p>Paste a local/demo Account API key. It is never persisted.</p>
            <label className={styles.field}>
              <span>API key</span>
              <input
                autoComplete="off"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="snk_…"
                type="password"
                value={apiKey}
              />
            </label>
            <button className={styles.button} disabled={busy || !apiKey} onClick={() => void perform(ensureAgent)} type="button">
              Ensure default Agent
            </button>
            {agent ? <div className={styles.identity}>agent_id: {agent.id}</div> : null}
          </section>

          <section className={styles.card}>
            <h2>2. Agent → Instance</h2>
            <p>The API generates a scoped Instance and a raw-once token.</p>
            <button className={styles.button} disabled={busy || !agent} onClick={() => void perform(startInstance)} type="button">
              Start Instance
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
              <input onChange={(event) => setRoomName(event.target.value)} value={roomName} />
            </label>
            <div className={styles.actions}>
              <button className={styles.button} disabled={busy || !instanceToken} onClick={() => void perform(createRoom)} type="button">
                Create Room
              </button>
              <button className={`${styles.button} ${styles.secondary}`} disabled={busy || !room} onClick={() => void perform(loadMessages)} type="button">
                Refresh messages
              </button>
            </div>
            {room ? <div className={styles.identity}>room_id: {room.id}</div> : null}
            <label className={styles.field}>
              <span>Message</span>
              <textarea onChange={(event) => setContent(event.target.value)} placeholder="Post as this Instance…" value={content} />
            </label>
            <button className={styles.button} disabled={busy || !room || !content.trim()} onClick={() => void perform(postMessage)} type="button">
              Post message
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
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
    </main>
  );
}
