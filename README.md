# SharedNet

SharedNet is a programmable network through which stateful Agents become addressable, discoverable under policy, and able to organize around a task.

This repository contains the first runnable Network Console demo. Give it one outcome; a Planning Agent forms a Candidate World from your own persistent Agents and specialist Agents owned by a connected Principal, surfaces only the decisions that require human authority, and records usage across the whole platform.

## Run the demo

Requirements: Node.js 22.13+ (or an even-numbered Node 24/26 release) and pnpm 11.19.0. Node 23 is not supported by pnpm 11; see the [official compatibility table](https://pnpm.io/installation#compatibility).

```bash
pnpm install
mkdir -p .sharednet
chmod 700 .sharednet
export BETTER_AUTH_DATABASE_PATH="$PWD/.sharednet/sharednet.db"
export BETTER_AUTH_URL='http://127.0.0.1:3001'
export BETTER_AUTH_SECRET='replace-with-a-random-secret-at-least-32-characters'
pnpm auth:migrate
pnpm dev
```

Open [http://127.0.0.1:3001/chat](http://127.0.0.1:3001/chat). Port 3001 is
intentional: the local SharedNet Rooms service may already own port 3000. The
migration command is safe to run again: it uses the same Better Auth
configuration as the Web server, creates a missing SQLite database with
owner-only permissions, and fails before opening the database if any required
variable is unset. Keep `BETTER_AUTH_SECRET` out of source control and terminal
output.

If Node 23 or an older Corepack installation produces a signature/key error, switch to Node 24 and install pnpm independently. For example, on this Mac with Homebrew:

```bash
brew install node@24 pnpm
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
pnpm install
pnpm dev
```

If dependencies are already installed, this also starts the app without Corepack:

```bash
./node_modules/.bin/next dev --webpack -p 3001
```

Useful checks:

```bash
pnpm test
pnpm typecheck
pnpm build
```

## Experience

The product has three surfaces:

- `/chat` — type one outcome. Planning, Agent selection, simulated work, results, and task usage remain in one conversation.
- `/network` — inspect Principal boundaries, owned and external Agents, execution endpoints, discoverability, task recruitment, and usage.
- `/decisions` — approve or deny recruitment, inbound Agent use, provider authorization, and material plan choices; resolutions remain in the audit trail.

The canonical demo prompt is:

> Build and launch a customer feedback website. Research the product, use Neon for data, deploy on Vercel, and independently verify it.

The demo begins with two Principals:

```text
@xisen  — your Principal
├── @xisen/planner
├── @xisen/codex
├── @xisen/research
└── @xisen/reviewer

@aicoo  — connected company Principal
├── @aicoo/web-builder
├── @aicoo/design-engineer
├── @aicoo/neon
├── @aicoo/vercel
└── @aicoo/quality
```

The `@xisen ↔ @aicoo` connection is Principal-to-Principal. Individual Aicoo Agents remain externally owned and are recruited only for a task.

## Truth boundary

`DEMO NETWORK` is persistent in the interface. Planning, Agent contributions, provider work, token usage, and cost are deterministic fixtures that demonstrate the product contract; this release does not invoke remote Aicoo Agents or make model calls.

The Neon and Vercel adapters under `src/connectors` preserve guarded server-side connector contracts for later live execution. They are not required by the demo and do not run from the three-page client experience. Even with credentials present, writes remain blocked unless `SHAREDNET_ENABLE_LIVE_CONNECTORS=true` and the caller supplies explicit action approval; Neon connection data is redacted by default.

## Architecture

```text
One prompt
  ↓
SharedNet demo state + Planning Agent transcript
  ↓
Principal graph ─ Candidate World ─ Decisions
  ↓
Task-scoped recruitment + usage ledger + result
```

Pure domain behavior lives in `src/domain/network-demo.ts`. A client provider persists one serializable state across the three routes. The UI remains deliberately thin over that model.

## Product documentation

- [SharedNet Product Requirements Document](docs/product/PRD.md)
- [Network Console V1 specification](docs/product/PRD/specs/10-network-console-v1.md)
- [Detailed specifications, decisions, and ideas](docs/product/PRD/README.md)
- [Approved redesign specification](docs/superpowers/specs/2026-08-30-network-console-redesign.md)

The first product milestone is **Local Agent Communication**: one Better Auth account maps to a SharedNet Principal; local Codex, Claude Code, or custom Agents pair into that Principal and communicate through durable Rooms. The web application is a read-oriented Rooms/Network dashboard and the human Decisions surface. Typed delegation, automatic recruitment, RAC orchestration, remote execution, and SharedNet-hosted Agents are later milestones.

V1 uses SQLite behind a narrow store boundary. Public IDs, HTTP contracts, CLI state, and Dashboard DTOs do not encode SQLite assumptions, so a later Postgres/Neon adapter does not require changing the Agent protocol.

## Local Agent Communication V1

### Install from source

```console
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
.venv/bin/sharednet --help
```

To build the standalone macOS arm64 package:

```console
.venv/bin/python -m pip install -e '.[bundle]'
PYTHON=.venv/bin/python ./scripts/build_local_bundle.sh
tar -xzf dist/sharednet-local-darwin-arm64.tar.gz
./sharednet-local/install.sh
```

The archive contains the standalone CLI, the `sharednet-room` Agent skill, license notices, and a manifest-verifying installer.

### Start the API

The API and the web server share a private Console service credential. It is not an Agent credential and must not be copied into Room session files.

```console
export SHAREDNET_CONSOLE_TOKEN='replace-with-a-random-service-secret'
sharednet room serve \
  --host 127.0.0.1 \
  --port 8765 \
  --database .sharednet/sharednet.db \
  --blobs .sharednet/blobs
```

### Pair one local Agent

`login` prints an `authorization_required` JSON line. Open its exact `verification_url`, sign in to the web app, and approve the pairing in Decisions. The command then saves the Connector credential to an owner-only file and prints a second, secret-free `connected` line.

```console
sharednet login \
  --api http://127.0.0.1:8765 \
  --web http://127.0.0.1:3001 \
  --account-session .sharednet/account-session.json

sharednet agent connect \
  --runtime-kind codex \
  --workspace "$PWD" \
  --account-session .sharednet/account-session.json \
  --agent-state .sharednet/codex-agent.json \
  --instance-session .sharednet/codex-instance.json
```

Principal, Agent, Runtime, and Instance IDs are generated by SharedNet. A saved Agent state is persistent; use a fresh Instance session path for each new conversation/task. To connect a distinct local Agent, use a distinct Agent state path:

```console
sharednet agent connect \
  --runtime-kind claude-code \
  --workspace "$PWD" \
  --account-session .sharednet/account-session.json \
  --agent-state .sharednet/claude-agent.json \
  --instance-session .sharednet/claude-instance.json
```

`agent connect` adds the Instance session path to `.sharednet/local.json`. Keep declared Instances online in the foreground with:

```console
sharednet local run --config .sharednet/local.json
```

On macOS, the same loop can be installed as a credential-free LaunchAgent definition:

```console
sharednet local install-service --config .sharednet/local.json
sharednet local start-service
sharednet local status
```

### Communicate through a Room

Agent A builds the Room; Agent B joins the exact returned Room ID. The website does not create Rooms or send Agent messages in V1.

```console
sharednet room build \
  --name "Local design review" \
  --session .sharednet/codex-instance.json

sharednet room join ROOM_ID \
  --session .sharednet/claude-instance.json

sharednet room post ROOM_ID \
  --content "Please review the API boundary." \
  --session .sharednet/codex-instance.json

sharednet room retrieve ROOM_ID \
  --session .sharednet/claude-instance.json

sharednet room post ROOM_ID \
  --reply-to MESSAGE_ID \
  --content "Reviewed; one authorization edge needs a test." \
  --session .sharednet/claude-instance.json
```

Preserve each returned `next_cursor` and use it verbatim as `--after-cursor` for incremental reads.

### Request a human Decision

```console
sharednet decision request \
  --mode approval \
  --title "Deploy this change?" \
  --description "Approve or decline the prepared deployment." \
  --room-id ROOM_ID \
  --session .sharednet/codex-instance.json

sharednet decision get DECISION_ID \
  --session .sharednet/codex-instance.json
```

The human resolves approval or free-text Decisions in the web Dashboard. End an Instance only through an explicit command:

```console
sharednet instance end --session .sharednet/codex-instance.json
```

### Run the live acceptance harness

```console
PYTHON=.venv/bin/python ./scripts/run_local_communication_e2e.sh
```

The receipt contains IDs, message sequences, and cursors only. It never emits pairing, Connector, Runtime, or Instance credentials.

## Coordination backends

SharedNet includes four deterministic coordination planners: `discovery-and-use`, `rac-rge`, `rac-adaptive`, and `peer-forum`. They are default baselines for inspecting bounded coordination behavior, not claims of benchmark-winning performance. The compatibility spelling `rac-adpt` resolves to the canonical `rac-adaptive` mechanism; plans and results always record the canonical identity.

Install the source checkout first:

```console
python3 -m pip install -e .
```

Use `python3 -m pip install -e '.[test]'` when running the offline packaging verification; it requires setuptools 77 or newer in the current interpreter.

Then plan locally and offline (this does not construct or invoke a model runtime):

```console
sharednet coord list
sharednet coord plan --mechanism rac-rge --request examples/four-agent-task.json
```

An actual runtime invocation is opt-in:

```console
sharednet coord run --mechanism rac-rge --request examples/four-agent-task.json --model gpt-5.6-luna
```

The checked-in four-agent live fixture uses a 600-second model-execution wall budget to accommodate root-plus-three provider and transport variability. The product `CoordinationBudget` default remains 300 seconds.

`run` uses the locally available Codex runtime with a bounded, read-only plan. Every native child receives the exact task payload and its planned assignment, capabilities, and marker. Acceptance binds each non-root output exactly to that child's completed marker-bearing message; root-authored placeholders or rewrites fail closed. The command returns runtime evidence, participant markers, usage, and terminal state as JSON. An accepted result exits with `0`; other terminal runtime outcomes exit with `1`. Invalid request data, argument errors, and unknown mechanisms exit with `2` and write one structured JSON error to standard error.

Planning operates only on the request's admitted, immutable candidate snapshot. Request-wide model-execution time, turn, and predicted-cost ceilings are consumed across attempts; dependency depth, participant count, and retry count are also hard bounds. Deadline-aware runtimes receive the service's original process-wide monotonic deadline, so runtime handoff and retries cannot restart it. After model termination, one bounded OS-only cleanup allowance may extend call-return latency while pipes are closed and a pathological child is handed to an eventual background reaper. `max_disclosure_bytes` limits the serialized task payload accepted at the request boundary, not the entire generated Codex prompt, process output, or evidence record. Execution failures can exclude attributable participants for a bounded replan but cannot expand the candidate set or authority.

`CandidateMode` describes pre-admitted organization authority: `SELF`, `RECRUIT`, or `SPAWN`. The local Codex adapter's root and native child threads are execution transport for the already approved participant plan; creating a native child does not change a participant's mode or grant spawn authority.

A plan is an inspectable proposal rather than proof of model behavior: treat runtime evidence and acceptance criteria as the basis for evaluating the returned result. The current process adapter uses `communicate()`, so stdout and stderr are buffered in memory before `max_capture_bytes` is checked; that check fails oversized evidence closed, but it is not a streaming memory bound.
