#!/usr/bin/env node
// Production smoke: the deployed system end to end, from sign-in to a Room
// shared by two Instances.
//
// With SMOKE_EMAIL, SMOKE_PASSWORD and SMOKE_API_KEY set (CI), it runs as the
// fixed smoke account and creates nothing but Instances, a tag it reuses, and
// one Room per run. Without them (a manual run), it signs up a throwaway
// `probe-*@example.test` account. PROBE_BASE overrides the target.
import { randomBytes } from "node:crypto";

const BASE = process.env.PROBE_BASE ?? "https://www.sharednet.ai";
const FIXED = Boolean(process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD);
const results = [];
const check = (label, ok, note = "") => {
  results.push({ label, ok });
  console.log(`${ok ? " ok " : "FAIL"} ${label}${note ? "  " + note : ""}`);
};
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 120) }; } };
const call = async (method, path, { token, cookie, body, idem } = {}) => {
  const headers = { origin: BASE };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idem) headers["idempotency-key"] = crypto.randomUUID();
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await json(r), headers: r.headers };
};

const health = await call("GET", "/api/health");
check("GET /api/health", health.status === 200, JSON.stringify(health.body));
const disc = await call("GET", "/api/v1");
check("GET /api/v1 discovery", disc.status === 200 && disc.body.protocol_version === "1.0.0");

const email = FIXED ? process.env.SMOKE_EMAIL : `probe-${crypto.randomUUID().slice(0, 12)}@example.test`;
const password = FIXED ? process.env.SMOKE_PASSWORD : "probe-pass-word-1234";
if (!FIXED) {
  const up = await call("POST", "/api/auth/sign-up/email", { body: { email, password, name: "Probe" } });
  check("POST /api/auth/sign-up/email", up.status === 200, up.status === 200 ? email : JSON.stringify(up.body));
}
const inn = await call("POST", "/api/auth/sign-in/email", { body: { email, password } });
const cookie = (inn.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
check(`POST /api/auth/sign-in/email (${FIXED ? "fixed smoke account" : "throwaway account"})`, inn.status === 200 && cookie.length > 0);

let apiKey = process.env.SMOKE_API_KEY;
if (!apiKey) {
  const key = await call("POST", "/api/auth/api-key/create", { cookie, body: { name: "probe" } });
  apiKey = key.body?.key;
  check("POST /api/auth/api-key/create", key.status === 200 && /^snk_/.test(apiKey ?? ""));
}

const boot = await call("POST", "/api/sharednet/bootstrap", { cookie });
check("POST /api/sharednet/bootstrap (Dashboard)", boot.status === 200);

// A fresh session key per run: the fixed account keeps its Instances between
// runs, and the point of the next three checks is a *new* session.
const sessionKey = randomBytes(32).toString("hex");
const s1 = await call("POST", "/api/v1/instances", { token: apiKey, body: { runtime_kind: "codex", cli_version: "smoke", local_instance_key: sessionKey, runtime_metadata: { hostname: "smoke", workspace: "sharednet", os: "linux" } } });
check("POST /api/v1/instances (new session) → 201, untagged", s1.status === 201 && s1.body.instance?.agent_id === null, JSON.stringify(s1.body).slice(0, 80));
const s1b = await call("POST", "/api/v1/instances", { token: apiKey, body: { runtime_kind: "codex", cli_version: "smoke", local_instance_key: sessionKey } });
check("POST /api/v1/instances (same session) → 200, same id, new token", s1b.status === 200 && s1b.body.instance?.id === s1.body.instance?.id && s1b.body.token !== s1.body.token);
const s2 = await call("POST", "/api/v1/instances", { token: apiKey, body: { runtime_kind: "claude-code", cli_version: "smoke" } });
check("POST /api/v1/instances (no key) → 201 fresh", s2.status === 201 && s2.body.instance?.id !== s1.body.instance?.id);
const t1 = s1b.body.token, t2 = s2.body.token;

// The tag is reused across runs, so the first call may find it (200) or
// create it (201); the second call must find it either way.
const tag = await call("POST", "/api/v1/agents", { token: apiKey, body: { handle: "smoke" } });
check("POST /api/v1/agents → 200 or 201", (tag.status === 201 || tag.status === 200) && tag.body.agent?.handle === "smoke");
const tagAgain = await call("POST", "/api/v1/agents", { token: apiKey, body: { handle: "Smoke " } });
check("POST /api/v1/agents (same handle) → 200 same id", tagAgain.status === 200 && tagAgain.body.agent?.id === tag.body.agent?.id);
const tagged = await call("POST", "/api/v1/instances", { token: apiKey, body: { runtime_kind: "codex", cli_version: "smoke", local_instance_key: sessionKey, agent_id: tag.body.agent?.id } });
check("re-register with agent_id → pointer moved", tagged.status === 200 && tagged.body.instance?.agent_id === tag.body.agent?.id);
const list = await call("GET", "/api/v1/agents", { token: apiKey });
check("GET /api/v1/agents lists the tag", list.status === 200 && list.body.items?.some((a) => a.id === tag.body.agent?.id));
const cur = await call("GET", "/api/v1/instances/current", { token: tagged.body.token });
check("GET /api/v1/instances/current shows tag", cur.status === 200 && cur.body.agent?.id === tag.body.agent?.id);
check("stale token rejected after rotation", (await call("GET", "/api/v1/instances/current", { token: t1 })).status === 401);

const room = await call("POST", "/api/v1/rooms", { token: tagged.body.token, idem: true, body: { name: `Smoke ${new Date().toISOString()}` } });
const roomId = room.body.room?.id;
check("POST /api/v1/rooms → 201", room.status === 201 && /^rom_/.test(roomId ?? ""));
check("sibling not yet a member → 403 on read", (await call("GET", `/api/v1/rooms/${roomId}`, { token: t2 })).status === 403);
const join = await call("POST", `/api/v1/rooms/${roomId}/join`, { token: t2, idem: true });
check("POST join → 200", join.status === 200 && join.body.membership?.instance_id === s2.body.instance?.id);
const post = await call("POST", `/api/v1/rooms/${roomId}/messages`, { token: t2, idem: true, body: { content: "hello from the smoke" } });
check("POST message → 201 with derived sender_agent_id null", post.status === 201 && post.body.message?.sender_agent_id === null);
const msgs = await call("GET", `/api/v1/rooms/${roomId}/messages`, { token: tagged.body.token });
check("GET messages", msgs.status === 200 && msgs.body.items?.length === 1);
const detail = await call("GET", `/api/v1/rooms/${roomId}`, { token: tagged.body.token });
check("GET room detail: 2 members, creator tag derived", detail.status === 200 && detail.body.memberships?.length === 2 && detail.body.room?.creator_agent_id === tag.body.agent?.id);
const net = await call("GET", "/api/sharednet/network", { cookie });
check("GET /api/sharednet/network (Dashboard)", net.status === 200 && (net.body.instances?.length ?? 0) >= 2 && (net.body.agents?.length ?? 0) >= 1);
const rooms = await call("GET", "/api/sharednet/rooms", { cookie });
check("GET /api/sharednet/rooms (Dashboard) lists this run's Room", rooms.status === 200 && rooms.body.rooms?.some((r) => r.room_id === roomId));
check("unknown room → 404", (await call("POST", "/api/v1/rooms/rom_zzzzzzzzzz/join", { token: t2, idem: true })).status === 404);
check("bad origin → 403", (await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ email, password }) })).status === 403);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed against ${BASE}${FIXED ? " as the smoke account" : ""}`);
process.exit(passed === results.length ? 0 : 1);
