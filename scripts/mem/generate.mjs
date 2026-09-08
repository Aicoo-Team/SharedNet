/**
 * SharedNet Mem, step 1: a multi-Agent conversation with ground truth.
 *
 * Seeds a few accounts, their tags and Instances, a handful of Rooms with
 * overlapping seats, and a log of messages. Some messages state facts about
 * named things ("the staging database rotates on Tuesday"); facts change
 * over time, later statements supersede earlier ones, and the rest is
 * chatter that reuses the same words. Everything that would count as memory
 * is written down as it happens: which Instance said which value of which
 * fact in which Room at which sequence. That is the truth a reader is
 * later judged against.
 *
 *   DATABASE_URL=postgresql://…/sharednet_e2e node --experimental-strip-types scripts/mem/generate.mjs \
 *     --out datasets/mem-01 [--agents 20] [--messages 1000] [--rooms 6] [--facts 40] [--seed 7] [--reset]
 *
 * With --reset the database's SharedNet schemas are dropped and migrated first (disposable databases only).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { defaultKeyHasher } from "@better-auth/api-key";

const url = process.env.DATABASE_URL;
assert.ok(url, "DATABASE_URL is required");
process.env.DATABASE_URL_UNPOOLED ??= url;
const args = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith("--")) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args.set(argv[i].slice(2), "true");
    else { args.set(argv[i].slice(2), next); i += 1; }
  }
}
const out = args.get("out") ?? "datasets/mem-run";
const AGENTS = Number(args.get("agents") ?? 20);
const MESSAGES = Number(args.get("messages") ?? 1000);
const ROOMS = Number(args.get("rooms") ?? 6);
const FACTS = Number(args.get("facts") ?? 40);
const seed = Number(args.get("seed") ?? 7);

// A small deterministic generator, so a dataset is reproducible from its seed.
let state = seed >>> 0 || 1;
const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (list) => list[Math.floor(random() * list.length)];
const shuffle = (list) => list.map((v) => [random(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

if (args.get("reset") === "true") {
  assert.ok(/e2e|test/.test(url), "--reset only on a database whose name contains e2e or test");
  const reset = new pg.Client({ connectionString: url });
  await reset.connect();
  try { await reset.query("DROP SCHEMA IF EXISTS sharednet, sharednet_auth, sharednet_migrations CASCADE"); } finally { await reset.end(); }
  const { migrateDatabase } = await import("../../packages/db/src/migrate.ts");
  await migrateDatabase({ connectionString: url });
}
const { createDatabase } = await import("../../packages/db/src/client.ts");
const { PostgresSharedNetRepository } = await import("../../packages/server/src/postgres-repository.ts");
const pool = new pg.Pool({ connectionString: url });
const repository = new PostgresSharedNetRepository(createDatabase(pool));

async function account(label) {
  const userId = `u_${randomUUID()}`;
  await pool.query(`insert into sharednet_auth."user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, false, now(), now())`, [userId, label, `${label}-${userId.slice(2, 10)}@example.test`]);
  const key = `snk_${Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43)}`;
  await pool.query(`insert into sharednet_auth.apikey (id, name, reference_id, key, enabled, created_at, updated_at) values ($1, $2, $3, $4, true, now(), now())`, [`key_${randomUUID().replace(/-/g, "").slice(0, 10)}`, label, userId, await defaultKeyHasher(key)]);
  return repository.authenticateApiKey(key);
}

// ---- The cast: a few Principals, each with tags, twenty Instances spread over them. ----
const principalCount = Math.max(2, Math.round(AGENTS / 5));
const handles = ["planner", "reviewer", "builder", "tester", "ops", "writer", "scout", "fixer"];
const drivers = ["claude-code", "codex", "cursor", "openhands", "workbuddy"];
const principals = [];
for (let p = 0; p < principalCount; p += 1) {
  const auth = await account(`mem-p${p + 1}`);
  const tags = [];
  for (const handle of shuffle(handles).slice(0, 2)) tags.push((await repository.createAgent(auth, { handle })).agent);
  principals.push({ auth, tags });
}
const instances = [];
for (let i = 0; i < AGENTS; i += 1) {
  const owner = principals[i % principals.length];
  const tag = random() < 0.75 ? pick(owner.tags) : null;
  const started = await repository.startInstance(owner.auth, { runtime_kind: pick(drivers), cli_version: "0.1.3", agent_id: tag?.id ?? null });
  instances.push({ id: started.instance.id, principal_id: owner.auth.principalId, agent_id: tag?.id ?? null, auth: await repository.authenticateInstance(started.token) });
}

// ---- Rooms with overlapping seats. ----
const roomNames = ["Launch review", "Ops handoff", "Data platform", "Hackathon floor", "Design crit", "Incident 4412", "Roadmap", "Docs sprint"];
const rooms = [];
for (let r = 0; r < ROOMS; r += 1) {
  const opener = instances[r % instances.length];
  const { room } = await repository.createRoom(opener.auth, { name: roomNames[r % roomNames.length] + (r >= roomNames.length ? ` ${r}` : "") });
  const seatCount = 3 + Math.floor(random() * Math.min(9, AGENTS - 3));
  const members = [opener, ...shuffle(instances.filter((i) => i !== opener)).slice(0, seatCount - 1)];
  for (const member of members.slice(1)) await repository.joinRoom(member.auth, room.id);
  rooms.push({ id: room.id, name: room.name, members });
}

// ---- Facts: named things whose value changes; every statement is truth. ----
const subjects = ["the staging database", "the release train", "the on-call rotation", "the auth service", "the design tokens", "the CI runner", "the pricing page", "the migration plan", "the incident bridge", "the rate limit", "the docs site", "the model gateway"];
const attributes = [
  { name: "owner", values: ["Mira", "Tomas", "Ada", "Kenji", "Priya", "Lars", "Noor", "Otis"] },
  { name: "deadline", values: ["Tuesday", "Thursday", "the 14th", "the 21st", "end of month", "Friday noon"] },
  { name: "version", values: ["2.3", "2.4", "3.0-rc1", "3.0", "3.1", "4.0"] },
  { name: "budget", values: ["12k", "18k", "25k", "40k", "9k"] },
  { name: "status", values: ["green", "amber", "red", "frozen", "shipped", "rolled back"] },
];
const facts = [];
for (let f = 0; f < FACTS; f += 1) {
  const subject = subjects[f % subjects.length];
  const attribute = attributes[Math.floor(f / subjects.length) % attributes.length];
  const key = `${subject} ${attribute.name}`;
  const updates = 1 + Math.floor(random() * 3);
  const values = shuffle(attribute.values).slice(0, updates);
  facts.push({ id: `fact_${String(f + 1).padStart(3, "0")}`, key, subject, attribute: attribute.name, values, room: pick(rooms), history: [] });
}
const phrasings = {
  owner: (s, v) => pick([`${s} is now owned by ${v}.`, `Heads up: ${v} takes over ${s} from today.`, `For the record, ${v} owns ${s}.`]),
  deadline: (s, v) => pick([`${s} is due ${v}.`, `We moved ${s} to ${v}.`, `Deadline for ${s}: ${v}.`]),
  version: (s, v) => pick([`${s} is on ${v}.`, `Bumped ${s} to ${v}.`, `${s} now runs ${v}.`]),
  budget: (s, v) => pick([`${s} budget is ${v}.`, `Finance approved ${v} for ${s}.`, `${s}: ${v}, final.`]),
  status: (s, v) => pick([`${s} is ${v}.`, `Status of ${s}: ${v}.`, `Calling ${s} ${v}.`]),
};
const chatter = ["Reading the history now.", "On it.", "Can someone review the PR?", "Lunch at 12:30?", "The build is slow again.", "I will take the tests.", "Agreed, let us do that.", "Pushed a fix for the flaky spec.", "Who has the dashboard link?", "Standup moved by ten minutes.", "Same here.", "Done, please check.", "The demo went fine.", "Draft is in the doc.", "I am not sure that is right; can you double-check?"];
// Distractors: the same subjects in sentences that state nothing.
const distractor = (s) => pick([`Any news on ${s}?`, `${s} came up in the meeting again.`, `Remind me what we decided about ${s}.`, `Looking at ${s} later today.`]);

// ---- The log: every message goes through the API's own door, in one sequence per Room. ----
const plan = [];
const factSlots = new Set();
while (factSlots.size < Math.min(MESSAGES - 1, facts.reduce((n, f) => n + f.values.length, 0))) factSlots.add(1 + Math.floor(random() * (MESSAGES - 1)));
const slotList = [...factSlots].sort((a, b) => a - b);
const statements = shuffle(facts.flatMap((fact) => fact.values.map((value, i) => ({ fact, value, index: i })))).sort((a, b) => a.fact.id.localeCompare(b.fact.id) || a.index - b.index);
// Keep each fact's updates in order across the log: assign slots fact by fact.
const byFact = new Map();
for (const st of statements) byFact.set(st.fact.id, [...(byFact.get(st.fact.id) ?? []), st]);
const slotsByFact = new Map();
let cursor = 0;
for (const [id, list] of byFact) { slotsByFact.set(id, slotList.slice(cursor, cursor + list.length)); cursor += list.length; }
for (const [id, list] of byFact) {
  const slots = slotsByFact.get(id).sort((a, b) => a - b);
  list.forEach((st, i) => plan.push({ at: slots[i], ...st }));
}
plan.sort((a, b) => a.at - b.at);
const truth = [];
const messagesOut = [];
let planned = 0;
for (let n = 1; n <= MESSAGES; n += 1) {
  const statement = plan[planned]?.at === n ? plan[planned++] : null;
  const room = statement ? statement.fact.room : pick(rooms);
  const speaker = pick(room.members);
  const content = statement
    ? phrasings[statement.fact.attribute](statement.fact.subject, statement.value)
    : random() < 0.3 ? distractor(pick(subjects)) : pick(chatter);
  const { message } = await repository.postMessage(speaker.auth, room.id, { content });
  messagesOut.push({ n, room_id: room.id, sequence: message.sequence, sender_instance_id: speaker.id, sender_principal_id: speaker.principal_id, sender_agent_id: speaker.agent_id, content, fact_id: statement?.fact.id ?? null });
  if (statement) {
    const event = { fact_id: statement.fact.id, key: statement.fact.key, value: statement.value, update_index: statement.index, room_id: room.id, sequence: message.sequence, message_id: message.id, sender_instance_id: speaker.id, sender_principal_id: speaker.principal_id, sender_agent_id: speaker.agent_id, supersedes: statement.fact.history.at(-1)?.value ?? null };
    statement.fact.history.push(event);
    truth.push(event);
  }
}

// ---- Questions: the current value of each fact, and who said it. ----
const questions = facts.filter((f) => f.history.length > 0).map((fact) => {
  const latest = fact.history.at(-1);
  return {
    id: `q_${fact.id.slice(5)}`,
    fact_id: fact.id,
    question: `What is the current ${fact.attribute} of ${fact.subject}?`,
    answer: latest.value,
    superseded: fact.history.slice(0, -1).map((e) => e.value),
    room_id: fact.room.id,
    latest_sequence: latest.sequence,
    latest_sender_instance_id: latest.sender_instance_id,
    latest_sender_agent_id: latest.sender_agent_id,
    keyword: fact.subject,
  };
});

await mkdir(out, { recursive: true });
await writeFile(join(out, "manifest.json"), JSON.stringify({ seed, agents: AGENTS, messages: MESSAGES, rooms: rooms.map((r) => ({ id: r.id, name: r.name, members: r.members.map((m) => m.id) })), instances: instances.map((i) => ({ id: i.id, principal_id: i.principal_id, agent_id: i.agent_id })), reader_key: null }, null, 2));
await writeFile(join(out, "messages.jsonl"), messagesOut.map((m) => JSON.stringify(m)).join("\n") + "\n");
await writeFile(join(out, "truth.jsonl"), truth.map((t) => JSON.stringify(t)).join("\n") + "\n");
await writeFile(join(out, "questions.jsonl"), questions.map((q) => JSON.stringify(q)).join("\n") + "\n");
// A reader's key: an Instance that sits in every Room, registered last, so it can read them all.
const readerAuth = await account("mem-reader");
const reader = await repository.startInstance(readerAuth, { runtime_kind: "custom", cli_version: "mem-reader" });
const readerInstance = await repository.authenticateInstance(reader.token);
for (const room of rooms) await repository.joinRoom(readerInstance, room.id);
await writeFile(join(out, "reader.json"), JSON.stringify({ instance_id: reader.instance.id, token: reader.token }, null, 2), { mode: 0o600 });
await pool.end();
console.log(JSON.stringify({ out, agents: instances.length, principals: principals.length, rooms: rooms.length, messages: messagesOut.length, facts: facts.length, statements: truth.length, questions: questions.length }));
