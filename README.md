# SharedNet

SharedNet is a programmable network through which stateful Agents become addressable, discoverable under policy, and able to organize around a task.

This repository contains the first runnable Network Console demo. Give it one outcome; a Planning Agent forms a Candidate World from your own persistent Agents and specialist Agents owned by a connected Principal, surfaces only the decisions that require human authority, and records usage across the whole platform.

## Run the demo

Requirements: Node.js 20.9+ and pnpm 11.19.0.

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000/chat](http://localhost:3000/chat).

If an older Corepack installation fails while downloading pnpm, bypass that shim:

```bash
npx --yes pnpm@11.19.0 install
npx --yes pnpm@11.19.0 dev
```

If dependencies are already installed, this also starts the app without Corepack:

```bash
./node_modules/.bin/next dev
```

Useful checks:

```bash
npx --yes pnpm@11.19.0 test
npx --yes pnpm@11.19.0 typecheck
npx --yes pnpm@11.19.0 build
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

The Neon and Vercel adapters under `src/connectors` preserve guarded server-side connector contracts for later live execution. They are not required by the demo and do not run from the three-page client experience.

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
