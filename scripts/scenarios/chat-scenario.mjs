/**
 * Multi-Instance chat scenarios against a local SharedNet (the dev server on
 * a local Postgres). Two subcommands:
 *
 *   setup  --principals 1|2 --seats N [--name '…']
 *       Seeds N accounts-or-seats on the database the dev server uses, opens a
 *       Room owned by the first Principal, mints an invite, and prints one
 *       block per seat: the environment (base URL, API key) and the exact
 *       command an Agent runs to join as that Principal. Keys are printed
 *       here and only here; the blocks are meant to be pasted into separate
 *       Agent sessions.
 *
 *   check --room rom_… [--principals 1|2]
 *       Reads the Room and judges the conversation: every seat's Principal,
 *       whether the seats took turns, whether each seat said it was done, and
 *       whether anybody echoed themselves. Exit 0 on pass.
 *
 *   DATABASE_URL=postgresql://…/sharednet_dev node --experimental-strip-types scripts/scenarios/chat-scenario.mjs setup --principals 1 --seats 2
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { defaultKeyHasher } from "@better-auth/api-key";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must point at the database the dev server uses.");
process.env.DATABASE_URL_UNPOOLED ??= url;
const baseUrl = (process.env.SHAREDNET_BASE_URL ?? "http://127.0.0.1:3002").replace(/\/+$/, "");

const { createDatabase } = await import("../../packages/db/src/client.ts");
const { PostgresSharedNetRepository } = await import("../../packages/server/src/postgres-repository.ts");
const pool = new pg.Pool({ connectionString: url });
const repository = new PostgresSharedNetRepository(createDatabase(pool));

const [command, ...rest] = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < rest.length; i += 2) args.set(rest[i].replace(/^--/, ""), rest[i + 1]);

async function account(label) {
  const userId = `u_${randomUUID()}`;
  await pool.query(
    `insert into sharednet_auth."user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, false, now(), now())`,
    [userId, label, `${label}-${userId.slice(2, 10)}@example.test`],
  );
  const key = `snk_${Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43)}`;
  await pool.query(
    `insert into sharednet_auth.apikey (id, name, reference_id, key, enabled, created_at, updated_at) values ($1, $2, $3, $4, true, now(), now())`,
    [`key_${randomUUID().replace(/-/g, "").slice(0, 10)}`, label, userId, await defaultKeyHasher(key)],
  );
  const auth = await repository.authenticateApiKey(key);
  return { label, key, principalId: auth.principalId, auth };
}

if (command === "setup") {
  const principals = Number(args.get("principals") ?? 1);
  const seats = Number(args.get("seats") ?? 2);
  const name = args.get("name") ?? `Scenario ${principals} Principal${principals > 1 ? "s" : ""}, ${seats} seats`;
  const accounts = [];
  for (let i = 0; i < principals; i += 1) accounts.push(await account(`scenario-p${i + 1}`));
  // The first account's Instance opens the Room; the owner mints the invite.
  const opener = await repository.startInstance(accounts[0].auth, { runtime_kind: "custom", cli_version: "scenario" });
  const openerAuth = await repository.authenticateInstance(opener.token);
  const { room } = await repository.createRoom(openerAuth, { name, description: "Multi-Instance chat scenario" });
  const { token } = await repository.createRoomInvite({ roomId: room.id, principalId: accounts[0].principalId });
  const invite = `ROOM=${room.id} TOKEN=${token} BASE=${baseUrl}`;
  const lines = [`Room ${room.id} "${name}" owned by ${accounts[0].principalId}`, ""];
  for (let i = 0; i < seats; i += 1) {
    const owner = accounts[i % principals];
    lines.push(`--- seat ${i + 1}: an Instance of ${owner.principalId} (${owner.label}) ---`);
    lines.push(`export SHAREDNET_BASE_URL=${baseUrl}`);
    lines.push(`export SHAREDNET_API_KEY=${owner.key}`);
    lines.push(`mkdir -p /tmp/sharednet-seat-${i + 1} && cd /tmp/sharednet-seat-${i + 1}`);
    lines.push(`sharednet join '${invite}' --name seat-${i + 1} --json`);
    lines.push("");
  }
  lines.push(`check: node --experimental-strip-types scripts/scenarios/chat-scenario.mjs check --room ${room.id} --principals ${principals}`);
  process.stdout.write(lines.join("\n") + "\n");
} else if (command === "check") {
  const roomId = args.get("room");
  const expectedPrincipals = Number(args.get("principals") ?? 1);
  const [ownerRow] = (await pool.query(`select principal_id from sharednet.room where id = $1`, [roomId])).rows;
  if (!ownerRow) throw new Error(`Room ${roomId} not found`);
  const detail = await repository.getRoomForPrincipal(ownerRow.principal_id, roomId);
  // Every seat but the scenario's own opener (an account seat carries no display name; its tag says who it is).
  const seats = detail.memberships.filter((m) => !(m.runtime_kind === "custom" && m.runtime_version === "scenario"));
  const messages = detail.messages.filter((m) => seats.some((s) => s.instance_id === m.sender_instance_id));
  const principals = new Set(seats.map((s) => s.principal_id));
  const findings = [];
  const pass = (label, ok, note) => findings.push({ check: label, ok, note });
  pass("every seat is an Instance of an account, none anonymous", seats.every((s) => s.kind === "instance"), seats.map((s) => `${s.instance_id}:${s.kind}`).join(" "));
  pass(`the seats belong to ${expectedPrincipals} Principal(s)`, principals.size === expectedPrincipals, [...principals].join(" "));
  pass("at least one Instance per seat spoke", seats.every((s) => messages.some((m) => m.sender_instance_id === s.instance_id)), `${messages.length} messages from ${seats.length} seats`);
  let turns = 0;
  for (let i = 1; i < messages.length; i += 1) if (messages[i].sender_instance_id !== messages[i - 1].sender_instance_id) turns += 1;
  pass("they took turns (at least two hand-overs)", turns >= 2, `${turns} hand-overs across ${messages.length} messages`);
  const done = (m) => /\b(done|finished|wrap(ping)? up|conclude|that'?s all|signing off|end(ing)? (the|this) (discussion|conversation))\b/i.test(m.content);
  pass("each seat said it was done, in its own words", seats.every((s) => messages.some((m) => m.sender_instance_id === s.instance_id && done(m))), messages.filter(done).map((m) => `#${m.sequence}`).join(" "));
  pass("the last message closes the conversation", messages.length > 0 && done(messages[messages.length - 1]), messages.length ? `#${messages[messages.length - 1].sequence}` : "no messages");
  // --final '<regex>': every seat's closing message must state the same final result, matching the pattern.
  const finalPattern = args.get("final");
  if (finalPattern) {
    const regex = new RegExp(finalPattern, "i");
    const finals = seats.map((s) => messages.filter((m) => m.sender_instance_id === s.instance_id && /FINAL:/i.test(m.content)).at(-1) ?? null);
    const stated = finals.map((m) => (m ? (m.content.match(/FINAL:.*$/im) ?? [""])[0].trim() : null));
    pass("each seat stated a FINAL result", finals.every((m) => m !== null), stated.map((t) => t ?? "none").join(" || "));
    pass("the FINAL results match the expected pattern", stated.every((t) => t !== null && regex.test(t)), finalPattern);
    pass("the seats agreed on the same FINAL result", stated.every((t) => t !== null && t.replace(/\s+/g, " ").toLowerCase() === stated[0].replace(/\s+/g, " ").toLowerCase()), "");
  }
  const echoes = messages.filter((m, i) => i > 0 && m.content === messages[i - 1].content);
  pass("nobody repeated the previous message", echoes.length === 0, `${echoes.length} repeats`);
  const ok = findings.every((f) => f.ok);
  process.stdout.write(JSON.stringify({ room: roomId, seats: seats.length, messages: messages.length, verdict: ok ? "pass" : "fail", findings }, null, 2) + "\n");
  await pool.end();
  process.exit(ok ? 0 : 1);
} else {
  throw new Error("Usage: chat-scenario.mjs setup --principals 1|2 --seats N | check --room rom_… --principals N [--final '<regex>']");
}
await pool.end();
