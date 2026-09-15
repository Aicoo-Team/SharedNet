#!/usr/bin/env node
// Production smoke: the deployed system end to end, from sign-in to a Room
// shared by two Instances, to a credit paid across it and paid back.
//
// With SMOKE_EMAIL, SMOKE_PASSWORD and SMOKE_API_KEY set (CI), it runs as the
// fixed smoke account and creates nothing but Instances, a tag it reuses, and
// one Room per run. Without them (a manual run), it signs up a throwaway
// `probe-*@example.test` account. SMOKE_CREDIT_CODE funds the purse the first
// time it runs, and is checked for granting nothing every time after.
// PROBE_BASE overrides the target.
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
// ---- Credits: the money path, on the deployed system. ----
// A purse belongs to a Principal, so the account key and a seat of that account
// must read the same one. The other party is the guest this Room's invite
// admits: an anonymous Principal, free to make, with a purse of its own. The
// credit paid to it is paid straight back, so a run leaves the purse where it
// found it and a leak shows up as a balance that falls.
check("discovery lists the credits capability", disc.body.capabilities?.includes("credits"));
check("GET /api/v1/credits unauthenticated → 401", (await call("GET", "/api/v1/credits")).status === 401);

// With SMOKE_CREDIT_CODE set, the first run ever funds the account and every
// run after grants nothing: one code, one Principal, once, for good.
if (process.env.SMOKE_CREDIT_CODE) {
  const grant = await call("POST", "/api/v1/credits/redeem", { token: apiKey, body: { code: process.env.SMOKE_CREDIT_CODE } });
  check("POST /api/v1/credits/redeem → 200", grant.status === 200, `granted ${grant.body.granted}`);
  // Straight away again: one code, one Principal, once, for good. The second
  // call is free — it grants nothing — so it can be made on every run.
  const again = await call("POST", "/api/v1/credits/redeem", { token: apiKey, body: { code: process.env.SMOKE_CREDIT_CODE } });
  check(
    "the same code again grants nothing, and names no transfer",
    again.status === 200 && again.body.granted === 0 && again.body.transfer === null &&
      again.body.credits?.balance === grant.body.credits?.balance,
  );
}

const purse = await call("GET", "/api/v1/credits", { token: apiKey });
const opening = purse.body.credits?.balance;
const principalId = purse.body.credits?.principal_id;
check("GET /api/v1/credits (account key)", purse.status === 200 && Number.isInteger(opening), `balance ${opening}`);
check(
  "the purse is granted + received − sent",
  purse.status === 200 && opening === purse.body.credits.granted + purse.body.credits.received - purse.body.credits.sent,
);
const seatPurse = await call("GET", "/api/v1/credits", { token: tagged.body.token });
check(
  "a seat reads its Principal's purse, not one of its own",
  seatPurse.status === 200 && seatPurse.body.credits?.principal_id === principalId && seatPurse.body.credits?.balance === opening,
);
check("redeem an unknown code → 404", (await call("POST", "/api/v1/credits/redeem", { token: apiKey, body: { code: "SMOKE-NO-SUCH-CODE" } })).status === 404);
check(
  "paying your own sibling seat → 422, it is the same purse",
  (await call("POST", "/api/v1/credits/transfers", { token: tagged.body.token, idem: true, body: { to: s2.body.instance?.id, amount: 1 } })).status === 422,
);
check(
  "a payment with no idempotency key → 400: money moves once",
  (await call("POST", "/api/v1/credits/transfers", { token: tagged.body.token, body: { to: principalId, amount: 1 } })).status === 400,
);

const invite = await call("POST", `/api/v1/rooms/${roomId}/invites`, { token: tagged.body.token });
check("POST /api/v1/rooms/{id}/invites → 201", invite.status === 201 && typeof invite.body.token === "string" && invite.body.token.startsWith("rit_"));
const guest = await call("POST", `/api/v1/rooms/${roomId}/join`, { token: invite.body.token, body: { name: "Smoke guest" } });
const guestToken = guest.body.member_token, guestSeat = guest.body.membership?.member_id;
check("an invite admits a guest → an anonymous seat", guest.status === 200 && /^i_/.test(guestSeat ?? "") && typeof guestToken === "string");
check(
  "an anonymous Principal cannot redeem a code → 403",
  (await call("POST", "/api/v1/credits/redeem", { token: guestToken, body: { code: process.env.SMOKE_CREDIT_CODE ?? "SMOKE-NO-SUCH-CODE" } })).status === 403,
);
check(
  "an empty purse cannot pay → 409",
  (await call("POST", "/api/v1/credits/transfers", { token: guestToken, idem: true, body: { to: principalId, amount: 1 } })).status === 409,
);

if (opening >= 1) {
  const out = await call("POST", "/api/v1/credits/transfers", { token: tagged.body.token, idem: true, body: { to: guestSeat, amount: 1, memo: "smoke", room_id: roomId } });
  check(
    "pay the guest's seat → 201, debited, and the paying seat recorded",
    out.status === 201 &&
      out.body.transfer?.to_principal_id === guest.body.membership?.principal_id &&
      out.body.transfer?.by_instance_id === tagged.body.instance?.id &&
      out.body.transfer?.room_id === roomId &&
      out.body.credits?.balance === opening - 1,
  );
  const held = await call("GET", "/api/v1/credits", { token: guestToken });
  check("the guest holds what was paid", held.status === 200 && held.body.credits?.balance === 1 && held.body.credits?.received === 1);
  const back = await call("POST", "/api/v1/credits/transfers", { token: guestToken, idem: true, body: { to: principalId, amount: 1, memo: "smoke, returned" } });
  check("the guest pays it back → 201, spent to nothing", back.status === 201 && back.body.credits?.balance === 0);
  const closing = await call("GET", "/api/v1/credits", { token: apiKey });
  check("the purse ends where it started", closing.body.credits?.balance === opening, `balance ${closing.body.credits?.balance}`);
  const ledger = await call("GET", "/api/v1/credits/transfers", { token: apiKey });
  check(
    "the ledger carries both halves of the round trip, newest first",
    ledger.status === 200 &&
      ledger.body.items?.[0]?.id === back.body.transfer?.id &&
      ledger.body.items?.[1]?.id === out.body.transfer?.id,
  );
} else {
  check("the smoke account holds a credit to move", false, "set SMOKE_CREDIT_CODE to a live grant code and run again");
}

check("unknown room → 404", (await call("POST", "/api/v1/rooms/rom_zzzzzzzzzz/join", { token: t2, idem: true })).status === 404);
check("bad origin → 403", (await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ email, password }) })).status === 403);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed against ${BASE}${FIXED ? " as the smoke account" : ""}`);
process.exit(passed === results.length ? 0 : 1);
