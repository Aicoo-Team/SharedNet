/**
 * SharedNet Mem, step 2: how well does a reading policy recover the truth?
 *
 * A reading policy is a query on the Room log: filter, order, window, at a
 * budget of k messages. For every question the dataset asked, each policy
 * builds its view through the same retrieval the API serves, and is scored:
 *
 *   sufficient   the message that states the current value is in the view
 *   stale-in     a superseded value's message is in the view
 *   unsafe-risk  stale-in and not sufficient: a reader can only be wrong
 *   chars        how much text the view costs
 *
 * Then a reader answers from the view. The built-in reader is extractive
 * (the newest message in the view that names the subject and one of the
 * known values); with OPENROUTER_API_KEY set and --reader llm, a model
 * answers instead. Accuracy is exact match; unsafety is answering a
 * superseded value.
 *
 *   DATABASE_URL=… node --experimental-strip-types scripts/mem/evaluate.mjs --dataset datasets/mem-01 [--k 5,10,20,50] [--reader extractive|llm]
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
assert.ok(url, "DATABASE_URL is required");
process.env.DATABASE_URL_UNPOOLED ??= url;
const args = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) { args.set(argv[i].slice(2), argv[i + 1] ?? "true"); i += 1; }
const dataset = args.get("dataset") ?? "datasets/mem-run";
const budgets = String(args.get("k") ?? "5,10,20,50").split(",").map(Number);
const readerKind = args.get("reader") ?? "extractive";

const lines = async (name) => (await readFile(join(dataset, name), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const questions = await lines("questions.jsonl");
const truth = await lines("truth.jsonl");
const reader = JSON.parse(await readFile(join(dataset, "reader.json"), "utf8"));

const { createDatabase } = await import("../../packages/db/src/client.ts");
const { PostgresSharedNetRepository } = await import("../../packages/server/src/postgres-repository.ts");
const pool = new pg.Pool({ connectionString: url });
const repository = new PostgresSharedNetRepository(createDatabase(pool));
const auth = await repository.authenticateInstance(reader.token);
assert.ok(auth, "the reader seat's token no longer authenticates");

const base = { after: 0, before: null, limit: 50, order: "asc", sender_instance_id: null, sender_agent_id: null, q: null };
/** The policies under test: each is a query, nothing more. */
const policies = {
  "head[:k]": (q, k) => ({ ...base, limit: k }),
  "recent[-k:]": (q, k) => ({ ...base, order: "desc", limit: k }),
  "grep subject, recent": (q, k) => ({ ...base, order: "desc", limit: k, q: q.keyword }),
  "grep subject + tag, recent": (q, k) => ({ ...base, order: "desc", limit: k, q: q.keyword, sender_agent_id: q.latest_sender_agent_id ?? "default" }),
  "sender only, recent": (q, k) => ({ ...base, order: "desc", limit: k, sender_instance_id: q.latest_sender_instance_id }),
};

const statementsByFact = new Map();
for (const event of truth) statementsByFact.set(event.fact_id, [...(statementsByFact.get(event.fact_id) ?? []), event]);

function extractiveReader(view, question) {
  const candidates = [question.answer, ...question.superseded];
  const newestFirst = [...view].sort((a, b) => b.sequence - a.sequence);
  for (const message of newestFirst) {
    if (!message.content.toLowerCase().includes(question.keyword.toLowerCase())) continue;
    const found = candidates.find((value) => message.content.includes(value));
    if (found) return found;
  }
  return null;
}

async function llmReader(view, question) {
  const key = process.env.OPENROUTER_API_KEY;
  assert.ok(key, "--reader llm needs OPENROUTER_API_KEY");
  const transcript = [...view].sort((a, b) => a.sequence - b.sequence).map((m) => `#${m.sequence} ${m.sender_instance_id}: ${m.content}`).join("\n");
  const body = {
    model: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v3.2",
    messages: [
      { role: "system", content: "You read a chat log and answer one question with the single current value, nothing else. If the log does not say, answer UNKNOWN." },
      { role: "user", content: `Log:\n${transcript}\n\nQuestion: ${question.question}\nAnswer with the value only.` },
    ],
    temperature: 0,
    max_tokens: 20,
  };
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  return (json.choices?.[0]?.message?.content ?? "").trim().replace(/^["'.]+|["'.]+$/g, "") || null;
}
const read = readerKind === "llm" ? llmReader : extractiveReader;

const report = {};
for (const [name, policy] of Object.entries(policies)) {
  for (const k of budgets) {
    const tally = { sufficient: 0, stale_in: 0, unsafe_risk: 0, chars: 0, correct: 0, unsafe: 0, unknown: 0, n: 0 };
    for (const question of questions) {
      const page = await repository.listMessages(auth, question.room_id, policy(question, k));
      const view = page.items;
      const ids = new Set(view.map((m) => m.sequence));
      const events = statementsByFact.get(question.fact_id) ?? [];
      const latest = events.at(-1);
      const sufficient = ids.has(latest.sequence);
      const staleIn = events.slice(0, -1).some((e) => ids.has(e.sequence));
      tally.n += 1;
      tally.sufficient += sufficient ? 1 : 0;
      tally.stale_in += staleIn ? 1 : 0;
      tally.unsafe_risk += staleIn && !sufficient ? 1 : 0;
      tally.chars += view.reduce((n, m) => n + m.content.length, 0);
      const answer = await read(view, question);
      if (answer === null || answer === "UNKNOWN") tally.unknown += 1;
      else if (answer === question.answer) tally.correct += 1;
      else if (question.superseded.includes(answer)) tally.unsafe += 1;
    }
    report[`${name} @${k}`] = {
      policy: name, k, n: tally.n,
      sufficiency: tally.sufficient / tally.n,
      stale_in_view: tally.stale_in / tally.n,
      unsafe_risk: tally.unsafe_risk / tally.n,
      accuracy: tally.correct / tally.n,
      unsafe_answers: tally.unsafe / tally.n,
      unknown: tally.unknown / tally.n,
      mean_chars: Math.round(tally.chars / tally.n),
    };
  }
}
await pool.end();
await writeFile(join(dataset, `report-${readerKind}.json`), JSON.stringify(report, null, 2));
const pct = (v) => `${Math.round(v * 100)}%`;
const rows = Object.values(report).map((r) => `| ${r.policy} | ${r.k} | ${pct(r.sufficiency)} | ${pct(r.unsafe_risk)} | ${pct(r.accuracy)} | ${pct(r.unsafe_answers)} | ${r.mean_chars} |`);
console.log(`| policy | k | sufficient | unsafe-risk | reader accuracy | reader unsafe | mean chars |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}`);
