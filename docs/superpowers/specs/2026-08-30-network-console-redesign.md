# SharedNet Network Console Redesign

**Date:** 2026-08-30  
**Status:** Approved for implementation  
**Supersedes:** The six-stage Website Launch wizard as the V1 product surface

## Product statement

SharedNet is a quiet command surface over an Agent network. A user types one goal. A Planning Agent forms a plan, selects owned and trusted external Agents, asks only for authority-bearing decisions, tracks platform-wide usage, and returns the result in the same conversation.

The V1 demo proves one product idea: an individual can ask SharedNet to build and launch a website, and SharedNet can visibly organize both the user's Agents and specialist Agents from a connected Principal.

## Information architecture

The application has exactly three product pages:

- `/chat` — state an outcome and watch the organization form in the transcript.
- `/network` — inspect Principals, Agents, ownership boundaries, and task-scoped recruitment.
- `/decisions` — approve or deny the moments that require human authority.

`/` redirects to `/chat`. A compact shared header contains only the product mark, those three links, a pending-decision count, and total token/cost usage.

## Demo network

The fixture contains two Principals.

### `@xisen` — Your Principal

- `@xisen/planner` — translates an outcome into a task graph and recruitment plan.
- `@xisen/codex` — implements the application in the task environment.
- `@xisen/research` — gathers product and implementation context.
- `@xisen/reviewer` — independently checks the result.

These are Intra-Principal Agents: the user owns the Principal and can invoke them under existing policy.

### `@aicoo` — Connected Principal

- `@aicoo/web-builder` — end-to-end web implementation specialist.
- `@aicoo/design-engineer` — interaction and interface specialist.
- `@aicoo/neon` — Neon database integration specialist.
- `@aicoo/vercel` — Vercel deployment specialist.
- `@aicoo/quality` — independent launch verifier.

These are Cross-Principal Agents. Their AgentCards are discoverable through the existing `@xisen ↔ @aicoo` Principal connection. Recruiting them creates a task-scoped relationship and can require an explicit decision.

## `/chat`

### Empty state

The main object is a single multiline input with the prompt “What do you want done?” and a submit action. A small example can fill the input with the website-launch task. There is no questionnaire, stage navigation, side rail, or up-front decomposition UI.

### Planning and execution transcript

Submitting a prompt appends a user entry and a concise Planning Agent response. For the website demo, the planner:

1. identifies the build, database, deployment, and verification needs;
2. keeps implementation and review Agents from `@xisen`;
3. proposes relevant specialists from `@aicoo`;
4. creates recruitment and provider-authorization decisions;
5. records simulated Agent contributions and a final demo deliverable.

Planning appears as ordinary transcript content, not as a separate form. Agent activity is presented as a compact run trace with explicit Principal labels. The final output includes a tangible site preview and implementation handoff, while retaining a visible `DEMO NETWORK` truth label.

If unresolved authority is required, the transcript links directly to `/decisions`. The deterministic demo may show the full illustrative run while clearly labeling all work as simulated.

## `/network`

The page visualizes the Principal boundary first and individual Agents second.

- `@xisen` and `@aicoo` each occupy a labeled Principal region.
- Solid internal lines or grouping represent Intra-Principal ownership.
- A solid Principal-to-Principal edge represents the durable connection.
- A dashed Agent-to-task or cross-boundary edge represents task-scoped recruitment.
- A visible legend explains both relationships in plain language.

Desktop lays the two Principal regions side by side with the connection between them. Mobile stacks the regions while preserving labels and edge semantics. Selecting an Agent reveals its capabilities, runtime metadata, discoverability, and usage inline; it does not create a fourth page.

## `/decisions`

The decisions page is a single queue with Pending and Resolved sections. It supports four decision types:

- `recruitment` — use specialist Agents from another Principal;
- `inbound_use` — allow another Principal to use one of the user's Agents;
- `authorization` — grant a provider or runtime permission such as Neon or Vercel;
- `plan` — choose between materially different execution paths.

Each item says who is requesting authority, what changes, why it is needed, and what approving or denying does. Approve and deny act inline, update shared state, and retain the resolution as an audit event. Routine internal coordination never appears here.

## Usage ledger

Every simulated Agent call creates a usage entry with:

```text
id, taskId, principalId, agentId, model,
inputTokens, outputTokens, cachedTokens,
costUsd, timestamp
```

The application aggregates raw input, output, cached, and total tokens plus normalized USD cost across the entire platform. The shared header always exposes the compact total. Chat shows the current task breakdown; Network shows per-Principal and per-Agent totals. V1 does not invent SharedNet credits.

## State and behavior

A client-side SharedNet demo provider owns one serializable state object and persists it to local storage. Pure domain functions create the fixture, submit a prompt, resolve a decision, select an Agent, and aggregate usage. This keeps page navigation coherent and makes behavior independently testable.

The V1 remains deterministic. It demonstrates the coordination contract and interaction model; it does not claim that remote Aicoo runtimes or real model calls executed. Existing guarded Neon and Vercel connectors may remain available to later live paths, but provider availability cannot block the demo.

## Visual system

- Warm off-white background, dark ink, muted borders, and one restrained green signal color.
- Anybody for display/labels and Albert Sans for reading text.
- Four-pixel spacing rhythm, tabular figures for usage, visible focus, and 44px minimum interactive targets.
- Flat surfaces and linework instead of floating card grids.
- No gradients, glass effects, chat bubbles, dashboard tiles, or decorative animation.
- Motion is limited to useful state changes and disabled under reduced-motion preferences.

## Acceptance criteria

1. The first screen is a sparse typing UI, and submitting one prompt creates an in-chat plan.
2. Navigation exposes only Chat, Network, and Decisions.
3. Network clearly separates `@xisen` owned Agents from `@aicoo` external Agents and explains Principal-level connection versus task recruitment.
4. Aicoo website, design, Neon, Vercel, and quality Agents are preloaded as external specialists.
5. Decisions supports recruitment, inbound use, authorization, and planning items with durable resolutions.
6. Usage totals remain coherent across all three pages and persist across navigation/reload.
7. The experience works at 390px and desktop widths with no horizontal overflow.
8. The demo boundary remains unmistakable.

