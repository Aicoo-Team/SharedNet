# SharedNet PRD workspace

The canonical product entry point is [`../PRD.md`](../PRD.md).

This folder lets the product definition grow without turning the master PRD into another thousand-line document.

## Document classes

### `specs/` — normative

A spec defines expected product behavior, object boundaries, invariants, flows, and release requirements for one coherent area. Implementations should be checked against these documents.

### `decisions/` — accepted rationale

A decision record captures a choice that materially changes the product model or architecture. It states the context, decision, consequences, and rejected alternatives. Accepted decisions must also be reflected in the master PRD and affected specs.

### `ideas/` — non-normative exploration

An idea note preserves a potentially valuable direction without quietly turning it into a commitment. Ideas become requirements only after product discussion, an accepted decision, and placement in the roadmap.

## Working rules

1. Keep [`../PRD.md`](../PRD.md) readable as the product contract and index.
2. Give each spec one clear owner and avoid duplicating detailed requirements across specs.
3. Link across specs instead of copying definitions.
4. Record material changes in `decisions/` and update every affected normative document in the same change.
5. Mark uncertainty explicitly in `ideas/`; normative specs should not contain hidden roadmap promises.
6. Treat contradictions as documentation bugs rather than relying on precedence.
7. Use stable descriptive filenames; numeric prefixes express recommended reading order, not release order.

## Current map

### Specifications

1. [Principals, Agents, and AgentCards](specs/01-principals-agents-agentcards.md)
2. [Discovery, Connections, and Delegation](specs/02-discovery-connections-delegation.md)
3. [Candidate World and RAC](specs/03-candidate-world-rac.md)
4. [Tasks, Messages, and Recovery](specs/04-tasks-messages-recovery.md)
5. [Environments and Execution](specs/05-environments-execution.md)
6. [Runtime and Session Bridges](specs/06-runtime-session-bridges.md)
7. [Product Experience](specs/07-product-experience.md)
8. [System Boundaries and Architecture](specs/08-system-boundaries.md)
9. [Roadmap and Evaluation](specs/09-roadmap-evaluation.md)
10. [Website Launch V1](specs/10-website-launch-v1.md)

### Decisions

- [ADR 0001 — Principal-scoped network relationships](decisions/0001-principal-scoped-network.md)

### Ideas

- [Missions and autonomous organizations](ideas/missions-and-autonomous-organizations.md)
- [Agent lifecycle, promotion, and accumulated experience](ideas/agent-lifecycle-and-promotion.md)
