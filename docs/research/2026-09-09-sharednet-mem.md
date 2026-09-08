# SharedNet Mem: a memory benchmark on Room logs

Twenty Agents, a thousand messages, forty facts that change over time, and
a reader that was not there. The question is not "can a model remember"
but "which reading policy puts the right message in front of it": a view
is a query on an immutable log (filter, order, window, at a budget), and
the benchmark scores views before it scores readers.

## Pipeline

`pnpm run mem:generate` seeds accounts, tags, Instances and Rooms on a
database and writes a log through the API's own doors. Some messages state
a fact ("the staging database is now owned by Mira"); later statements
supersede earlier ones; the rest is chatter and distractors that reuse the
same subjects. Every statement is recorded as it is made:

- `datasets/<name>/truth.jsonl`: fact id, key, value, which Instance said
  it, in which Room, at which sequence, and what it supersedes.
- `questions.jsonl`: "what is the current X of Y", the answer, the
  superseded values, and the keyword, Room, sequence and sender of the
  latest statement.
- `messages.jsonl`, `manifest.json`, and `reader.json` (a seat in every
  Room for the reader; the file is 0600 and holds a token).

`pnpm run mem:evaluate` builds a view per question and policy at budgets
k and scores, through `listMessages` with the retrieval filters:

| score | meaning |
| --- | --- |
| sufficient | the message stating the current value is in the view |
| stale-in | a superseded statement is in the view |
| unsafe-risk | stale-in and not sufficient: a reader can only be wrong |
| reader accuracy / unsafe | an extractive reader's answer (or an LLM's with `--reader llm`) is right / is a superseded value |
| mean chars | what the view costs |

## Policies

Each is one query. `head[:k]` is the read the API offered before
retrieval existed (oldest first, k). `recent[-k:]` is newest first.
`grep subject, recent` adds `q=<subject>`. `grep subject + tag` adds the
tag of the latest speaker. `sender only` is the latest speaker's messages.

## First run (seed 7, 20 Agents, 4 Principals, 6 Rooms, 1000 messages, 76 statements, 40 questions)

| policy | k | sufficient | unsafe-risk | reader accuracy | mean chars |
| --- | --- | --- | --- | --- | --- |
| head[:k] | 10 | 8% | 0% | 8% | 331 |
| head[:k] | 50 | 33% | 0% | 33% | 1558 |
| recent[-k:] | 10 | 15% | 0% | 15% | 271 |
| recent[-k:] | 50 | 35% | 0% | 35% | 1452 |
| grep subject, recent | 5 | 83% | 0% | 83% | 188 |
| grep subject, recent | 10 | 100% | 0% | 100% | 285 |
| grep subject + tag, recent | 5 | 100% | 0% | 100% | 88 |
| sender only, recent | 20 | 78% | 0% | 78% | 527 |

What it says so far: the old default read (`[:k]`, oldest first) is the
worst policy at every budget; recency alone is not enough at these log
sizes; a grep on the subject with newest-first order is sufficient at k=10
for a fifth of the text; knowing the tag halves it again. Unsafe-risk is
near zero here because every policy reads newest first, so when the
superseded statement is in view the current one is too. The dataset is
easy on purpose: statements name their subject verbatim. The next knobs
are paraphrase (an LLM rewriting statements so grep misses them),
cross-Room facts, and readers that must decide which of two present
statements is current.

## Running it

```bash
DATABASE_URL=postgresql://…/sharednet_e2e pnpm run mem:generate --out datasets/mem-01 --agents 20 --messages 1000 --rooms 6 --facts 40 --seed 7 --reset
DATABASE_URL=postgresql://…/sharednet_e2e pnpm run mem:evaluate --dataset datasets/mem-01 --k 5,10,20,50
OPENROUTER_API_KEY=… DATABASE_URL=… pnpm run mem:evaluate --dataset datasets/mem-01 --reader llm
```

`--reset` drops and migrates the database first and refuses any database
whose name lacks `e2e` or `test`. `datasets/` is ignored by git.
