# SharedNet

Give SharedNet a rough website idea. It asks the decisions that matter, forms an official Agent organization, executes a dependency-aware Mission, and returns an interactive preview plus the work behind it.

Website Launch is the runnable V1 wedge for the larger product:

> **SharedNet is a programmable network through which stateful Agents become addressable and able to organize around a task.**

## Run V1

Requirements: Node.js 20.9+ and pnpm 11.19.0.

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Useful checks:

```bash
pnpm test
pnpm typecheck
pnpm build
```

## What the demo does

1. Accepts one outcome such as “Build a customer feedback board.”
2. Uses `@sharednet/product` to resolve seven material product decisions.
3. Compiles a concise Product Brief and acceptance boundary.
4. Lets RAC select the smallest useful organization from seven persistent SharedNet official Agents.
5. Executes research → architecture → database → build → deploy → independent verification → handoff in dependency order.
6. Returns an interactive product preview, generated source, schema, architecture, redacted infrastructure manifest, and verification evidence.

The official V1 bench is maintained by SharedNet:

```text
@sharednet/product       requirement lead
@sharednet/research      evidence scout
@sharednet/architect     system designer
@sharednet/builder       implementation worker
@sharednet/neon          data-layer specialist
@sharednet/vercel        deployment specialist
@sharednet/quality       independent verifier
```

“Official” does not imply affiliation with or endorsement by Neon or Vercel.

## Infrastructure truth

The default mode is deterministic and needs no provider account. It runs the real interview, RAC state machine, Agent selection, artifact generation, connector contract, and verification model. Neon and Vercel resources are clearly labeled `SIMULATED` and are not created externally.

Live mode is guarded and experimental. Copy `.env.example` to `.env.local`, provide server-side credentials, set `SHAREDNET_ENABLE_LIVE_CONNECTORS=true`, choose **Connected providers**, and explicitly approve external project creation in the Product Brief. Tokens never enter browser state or downloadable artifacts.

```bash
cp .env.example .env.local
```

Live execution can create billable Neon and Vercel resources. V1 has no multi-tenant authentication, so enable it only in a trusted, access-controlled, single-user instance. Creation failures with ambiguous provider state stop the Mission in `reconciliation-required` rather than retrying blindly.

## Architecture

```text
Mission UI
  ↓
Interview + Product Brief compiler
  ↓
Deterministic RAC Mission engine
  ↓
Artifact generator + guarded connectors
                         ├── Neon demo/live adapter
                         └── Vercel demo/live adapter
```

The V1 app is intentionally frontend-light: domain behavior lives in pure TypeScript modules under `src/domain`, provider authority stays under `src/connectors` and server routes, and the browser presents one six-stage Mission workspace.

## Product documentation

- [SharedNet Product Requirements Document](docs/product/PRD.md)
- [Website Launch V1 specification](docs/product/PRD/specs/10-website-launch-v1.md)
- [Detailed specifications, decisions, and ideas](docs/product/PRD/README.md)

Website Launch proves the outcome-shaped interaction first. Real local Codex/Claude runtime organization, Connected Principals, SharedNet Cloud routes, and enterprise Environment providers expand the same Principal, Agent, Candidate World, RAC, and SharedOS model in later releases.
