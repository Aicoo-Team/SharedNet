#!/usr/bin/env node
// Production smoke: the deployed system end to end, from sign-up to a Room
// shared by two Instances. Creates one throwaway `probe-*@example.test`
// account per run. Usage: node scripts/smoke-production.mjs
//   PROBE_BASE=https://www.sharednet.ai (default) overrides the target.
const BASE = process.env.PROBE_BASE ?? "https://www.sharednet.ai";
const results = [];
const check = (label, ok, note = "") => { results.push({ label, ok, note }); console.log(`${ok ? " ok " : "FAIL"} ${label}${note ? "  " + note : ""}`); };
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

const email = `probe-${crypto.randomUUID().slice(0, 12)}@example.test`, password = "probe-pass-word-1234";
const up = await call("POST", "/api/auth/sign-up/email", { body: { email, password, name: "Probe" } });
check("POST /api/auth/sign-up/email", up.status === 200, up.status === 200 ? email : JSON.stringify(up.body));
const inn = await call("POST", "/api/auth/sign-in/email", { body: { email, password } });
const cookie = (inn.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
check("POST /api/auth/sign-in/email", inn.status === 200 && cookie.length > 0);
const key = await call("POST", "/api/auth/api-key/create", { cookie, body: { name: "probe" } });
const apiKey = key.body?.key;
check("POST /api/auth/api-key/create", key.status === 200 && /^snk_/.test(apiKey ?? ""));

const boot = await call("POST", "/api/sharednet/bootstrap", { cookie });
check("POST /api/sharednet/bootstrap (Dashboard)", boot.status === 200);

const k1 = "a".repeat(64);
const s1 = await call("POST", "/api/v1/instances", { token: apiKey, body: { runtime_kind: "codex", cli_version: "probe", local_instance_key: k1, runtime_metadata: { hostname: "probe", workspace: "sharednet", os: "linux" } } });
check("POST /api/v1/instances (new) → 201, untagged", s1.status === 201 && s1.body.instance?.agent_id === null, JSON.stringify(s1.body).slice(0, 80));
const s1b = await call("POST", "/api/v1/instances", { token: apiKey, body: { runtime_kind: "codex", cli_version: "probe", local_instance_key: k1 } });
check("POST /api/v1/instances (same session) → 200, same id, new token", s1b.status === 200 && s1b.body.instance?.id === s1.body.instance?.id && s1b.body.token !== s1.body.token);
const s2 = await call("POST", "/api/v1/instances", { token: apiKey, body: { runtime_kind: "claude-code", cli_version: "probe" } });
check("POST /api/v1/instances (no key) → 201 fresh", s2.status === 201 && s2.body.instance?.id !== s1.body.instance?.id);
const t1 = s1b.body.token, t2 = s2.body.token;

const tag = await call("POST", "/api/v1/agents", { token: apiKey, body: { handle: "reviewer" } });
check("POST /api/v1/agents → 201", tag.status === 201 && tag.body.agent?.handle === "reviewer");
const tagAgain = await call("POST", "/api/v1/agents", { token: apiKey, body: { handle: "Reviewer " } });
check("POST /api/v1/agents (same handle) → 200 same id", tagAgain.status === 200 && tagAgain.body.agent?.id === tag.body.agent?.id);
const tagged = await call("POST", "/api/v1/instances", { token: apiKey, body: { runtime_kind: "codex", cli_version: "probe", local_instance_key: k1, agent_id: tag.body.agent?.id } });
check("re-register with agent_id → pointer moved", tagged.status === 200 && tagged.body.instance?.agent_id === tag.body.agent?.id);
const list = await call("GET", "/api/v1/agents", { token: apiKey });
check("GET /api/v1/agents", list.status === 200 && list.body.items?.length === 1);
const cur = await call("GET", "/api/v1/instances/current", { token: tagged.body.token });
check("GET /api/v1/instances/current shows tag", cur.status === 200 && cur.body.agent?.id === tag.body.agent?.id);
check("stale token rejected after rotation", (await call("GET", "/api/v1/instances/current", { token: t1 })).status === 401);

const room = await call("POST", "/api/v1/rooms", { token: tagged.body.token, idem: true, body: { name: "Probe Room" } });
const roomId = room.body.room?.id;
check("POST /api/v1/rooms → 201", room.status === 201 && /^rom_/.test(roomId ?? ""));
check("sibling not yet a member → 403 on read", (await call("GET", `/api/v1/rooms/${roomId}`, { token: t2 })).status === 403);
const join = await call("POST", `/api/v1/rooms/${roomId}/join`, { token: t2, idem: true });
check("POST join → 200", join.status === 200 && join.body.membership?.instance_id === s2.body.instance?.id);
const post = await call("POST", `/api/v1/rooms/${roomId}/messages`, { token: t2, idem: true, body: { content: "hello from the probe" } });
check("POST message → 201 with derived sender_agent_id null", post.status === 201 && post.body.message?.sender_agent_id === null);
const msgs = await call("GET", `/api/v1/rooms/${roomId}/messages`, { token: tagged.body.token });
check("GET messages", msgs.status === 200 && msgs.body.items?.length === 1);
const detail = await call("GET", `/api/v1/rooms/${roomId}`, { token: tagged.body.token });
check("GET room detail: 2 members, creator tag derived", detail.status === 200 && detail.body.memberships?.length === 2 && detail.body.room?.creator_agent_id === tag.body.agent?.id);
const net = await call("GET", "/api/sharednet/network", { cookie });
check("GET /api/sharednet/network (Dashboard)", net.status === 200 && net.body.instances?.length === 2 && net.body.agents?.length === 1);
const rooms = await call("GET", "/api/sharednet/rooms", { cookie });
check("GET /api/sharednet/rooms (Dashboard)", rooms.status === 200 && rooms.body.rooms?.length === 1);
check("unknown room → 404", (await call("POST", "/api/v1/rooms/rom_zzzzzzzzzz/join", { token: t2, idem: true })).status === 404);
check("bad origin → 403", (await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ email, password }) })).status === 403);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
