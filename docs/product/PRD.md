# SharedNet — Product Requirements Document

> **Status:** Draft v0.5 — Website Launch V1 implemented
>
> **Owner:** Xisen Wang
>
> **Last updated:** 2026-08-29
>
> **Composition:** SharedNet = network control plane + Runtime Agent Coordination (RAC) + SharedOS + runtime/session bridges + Environment providers

## 0. How to read this PRD

This file is the product-level contract. It defines the promise, scope, core objects, non-negotiable principles, and release sequence without attempting to contain every subsystem detail.

Detailed documents live in [`PRD/`](PRD/README.md):

- [`PRD/specs/`](PRD/specs/) contains normative subsystem specifications;
- [`PRD/decisions/`](PRD/decisions/) records accepted product and architecture decisions with their rationale;
- [`PRD/ideas/`](PRD/ideas/) contains non-normative explorations that are not roadmap commitments.

If this file and a detailed spec appear to disagree, treat that as a documentation bug. Resolve it by updating both and recording a decision when the product contract changed; do not silently choose one.

## 1. Bottom line

> **SharedNet is a programmable network through which stateful Agents become addressable, discoverable under policy, and able to organize around a task.**

SharedNet answers:

> **How do Agents find each other and work together?**

SharedNet Cloud answers:

> **Where can an Agent run when its owner wants a managed runtime?**

Cloud is a subproduct and Environment provider inside SharedNet. It is not a second network, a separate Agent type, or a remote clone.

The governing architectural principle is:

> **SharedNet does not care where an Agent runs. SharedNet Cloud is simply the easiest place to run one.**

The first runnable release is deliberately narrower than the complete network:

> **Give SharedNet a rough website idea; it resolves the product decisions that matter, forms the smallest useful official Agent organization, and returns an interactive preview with source, infrastructure truth, and independent verification.**

Website Launch V1 proves the outcome-shaped interaction, RAC dependency graph, durable Mission model, official AgentCards, guarded external-action boundary, and evidence-bearing handoff. Its provider resources are simulated by default. It does not yet prove live Codex/Claude session coordination or Cross-Principal recruitment.

## 2. Product thesis

Useful Agents already exist in fragmented places:

- live Codex and Claude Code sessions;
- persistent personal Agents with accumulated context;
- fresh local workers created for one task;
- teammates' Agents;
- managed Cloud runtimes;
- company VPC and on-premises runtimes.

The missing layer is not another model harness. It is a network and coordination layer that makes these Agents:

- stable in identity without equating identity with a process or session;
- discoverable without making them globally public;
- reachable without granting execution authority;
- recruitable through explicit, task-scoped contracts;
- organizable by an adaptive coordination algorithm;
- durable across runtime, process, and machine failure;
- observable as one accountable task rather than a pile of chats.

SharedNet unifies two product shapes:

1. **Local organization:** several Agents and workers on one person's computer solve a task together.
2. **Network delegation:** an Agent recruits another Principal's persistent Agent and continues after the reply.

These are the same mechanism at different Candidate World radii. Local, Cloud, and private execution are placement choices inside the same network.

## 3. The defining interaction

The user gives SharedNet a goal in natural language. The user owns the outcome, constraints, authority ceiling, approvals, and acceptance criteria. SharedNet owns the organization inside those bounds.

The implemented V1 interaction is:

```text
Rough website outcome
  ↓
Product Agent asks seven material questions
  ↓
User confirms one Product Brief
  ↓
RAC selects official specialist Agents
  ↓
Dependency-aware Mission execution
  ↓
Interactive preview + source + manifests + independent evidence
```

This uses SharedNet-owned persistent Agent identities and deterministic execution so the full product contract can be experienced before live runtime bridges are complete.

A later network-native signature prompt is:

> 你先联系一下 Liyi 的 Agent，让它分析 API 设计；拿到回复以后，你自己完成实现。如果有必要，再找 reviewer。

SharedNet interprets this as **Graph Intent**:

- `@liyi` is a required Cross-Principal collaborator;
- API analysis must finish before implementation;
- the requesting Agent remains the implementer;
- an independent reviewer is conditional rather than unconditional fan-out;
- all information disclosure, authority, cost, depth, retries, and stopping conditions remain bounded.

The runtime flow is:

```text
Natural-language goal
  ↓
TaskSpec + Graph Intent
  ↓
Task search scope × Agent exposure policy
  ↓
Candidate World query + admission
  ↓
Immutable Candidate Snapshot
  ↓
RAC forms the smallest useful organization
  ↓
SELF / RECRUIT / SPAWN participants
  ↓
SharedOS-authorized execution
  ↓
Verified result + organization graph + trace
```

The organization graph is an execution result, not a workflow that the user must draw in advance.

## 4. Principal-scoped network model

### 4.1 Principal

Every SharedNet account maps to a stable **Principal**. A Principal is the ownership, trust, policy, billing, and relationship boundary. It may initially represent a person and later also represent a team or company.

A Principal owns:

- persistent Agents;
- network relationships;
- default task and approval policies;
- Environment and runtime registrations;
- audit, billing, and administrative controls.

### 4.2 Agent

A Principal may own multiple persistent Agents:

```text
@xisen                         Principal
├── @xisen/coding             persistent Agent
├── @xisen/research           persistent Agent
└── @xisen/reviewer           persistent Agent
```

An Agent has one stable identity and may advertise several eligible execution routes. Starting a process, opening a session, or spawning a task worker does not automatically create another persistent Agent.

### 4.3 Connections and delegation

Persistent network **Connections exist between Principals**, not between every pair of Agents. This keeps the trust graph legible and avoids an N-by-M Agent friendship graph.

```text
@xisen  ← Principal Connection →  @liyi
   │                                │
owned Agents                    owned Agents
   └──────── task-scoped Delegation ────────┘
```

A Principal Connection establishes a path for policy-controlled discovery and approach. It does not grant task execution or data access. Actual Agent-to-Agent collaboration is represented by a task-scoped **Delegation Contract**.

Same-Principal Agents do not need persistent Connection objects. Principal policy controls whether they may discover and recruit one another; each actual collaboration still receives a task-scoped contract and SharedOS grants.

### 4.4 Discoverability and Candidate radius

Discovery has two independent sides:

```text
Requester policy
  Which radius may this task search?
  → Intra-Principal / connected Principals / selected Principals

Provider policy
  Which of my Agents may this caller discover?
  → hidden / Intra-Principal / connections / allowlist / public later
```

The effective Candidate World is their intersection:

```text
Candidate World
= Task Search Scope
∩ Agent Exposure Policy
∩ Principal Relationship
∩ admission constraints
```

SharedNet keeps four properties separate:

```text
Existence visibility ≠ AgentCard visibility ≠ recruitability ≠ execution authority
```

Knowing an exact Agent ID never bypasses exposure policy, recipient acceptance, or SharedOS authorization.

## 5. AgentCards and execution placement

An **AgentCard** is a versioned, caller-relative view of an Agent. It may expose:

- stable identity and owner Principal;
- capabilities and accepted task classes;
- availability and recruitment posture;
- verified experience summaries;
- eligible execution routes and their cost, latency, context, and background properties;
- disclosure and onward-delegation limits.

There is no single globally complete AgentCard. The owner may see all routes and private metadata while a connected Principal sees only capabilities and an eligible Cloud route.

Local, SharedNet Cloud, and private VPC are execution metadata:

```text
Agent: @xisen/coding
execution:
  - provider: local
    runtime: codex
    visibility: intra_principal
  - provider: sharednet_cloud
    runtime: codex
    visibility: connected_principals
  - provider: systemind_vpc
    runtime: custom
    visibility: allowlist
```

Routing selects an authorized execution route after Agent selection. Route selection never clones Agent identity.

## 6. Coordination policy

SharedNet should not maximize the number of Agents. RAC forms the **smallest useful organization** that is expected to improve the verified result under the task's budget and authority ceiling.

The default decision policy is:

```text
Short and linear
→ SELF

Truly independent branches
→ SPAWN parallel workers

High-risk and independently verifiable
→ independent verifier

Special context, ownership, or expertise
→ RECRUIT persistent Agent

Long-running or failure-prone
→ durable checkpoints and recoverable attempts
```

The system must avoid recursive fan-out that adds cost without information gain. Parallelism, specialization, verification, and durability are separate reasons to add organizational structure.

## 7. Environment and execution model

SharedNet distinguishes three environment levels:

1. **Agent home Environment** — persistent workspace, accepted memory, tools, and policy owned by a persistent Agent.
2. **Task Environment** — the logical working set, artifacts, evidence, and integration state for one Task.
3. **Participant Sandbox** — an isolated process, worktree, container, or microVM used by one task participant.

Several participants may share the same physical host or task-level VM, but they must not silently share authority, secrets, mutable session state, or the same writable checkout.

Task-owned local workers may receive isolated worktrees derived from the Task Environment. A recruited Cross-Principal Agent remains in its owner's Environment by default and receives only the contract-approved context; it returns messages, artifacts, and evidence rather than entering the requester's workspace.

One designated integrator owns canonical mutation. The implementation may use processes, containers, or microVMs according to risk without changing the product object model.

## 8. Product shape

The product is algorithm- and backend-heavy with a deliberately light frontend.

The implemented V1 framing leads with an outcome:

> **Bring the outcome. SharedNet forms the company around it.**

The first task family is Website Launch. A user should not need to understand Candidate World, RAC, local versus Cloud placement, Neon, or Vercel before describing what they want to ship. Those objects appear progressively as SharedNet explains its decisions and returns the work.

The network-level framing remains:

> **A programmable network for AI agents.**

Two entry points sit beneath it:

- **Bring your Agents** — connect Codex, Claude Code, or a custom runtime.
- **Run them with us** — create a persistent Agent with a managed SharedNet Cloud route.

The primary action is still a prompt, not a configuration UI. Advanced policy may narrow or expand the allowed Candidate radius, but RAC decides the actual organization.

The web app focuses on:

- installation and onboarding;
- owned and discoverable Agents;
- caller-relative AgentCards and execution routes;
- Principal Connections and exposure policy;
- Candidate World, admission reasons, and selection;
- running and completed Tasks;
- generated organization graph and trace;
- permissions, cost, reliability, and verification dashboards.

### 8.1 Product hierarchy and packaging

SharedNet is the parent product. Cloud, RAC, Console, CLI, SDK, and Skills are capabilities or subproducts, not independent brands or networks.

```text
SharedNet
├── Network
├── RAC
├── Cloud
├── Console
├── CLI / SDK / Skills
└── Enterprise controls and private providers
```

Recommended public structure:

```text
sharednet.ai
sharednet.ai/cloud
sharednet.ai/rac
sharednet.ai/docs
```

| Layer | Product role | Economic role |
| --- | --- | --- |
| SharedNet Network | Principal identity, AgentCards, Connections, basic messaging and Tasks, developer access | Grow useful network participation and distribution |
| RAC | Advanced candidate selection, organization, verification, and experience-aware policy | Intelligence margin |
| SharedNet Cloud | Managed runtime, compute, storage, background execution, and model usage | Usage-based infrastructure margin |
| Enterprise | Governance, SSO, audit, private networking, policy, and VPC/on-premises providers | Governance and deployment margin |

Packaging must share one Principal, Agent, Connection, Task, and trace model rather than fragmenting the network.

## 9. System composition

| Layer | Responsibility |
| --- | --- |
| SharedNet | Durable Principal, Agent, Connection, AgentCard, Task, message, policy, lifecycle, recovery, and observability control plane |
| RAC | Candidate admission/ranking inputs, `SELF`/`RECRUIT`/`SPAWN`, bounded organization, verification, rerouting, and terminal coordination ledger |
| SharedOS | Capability grants, point-of-use authorization, resource/tool boundary, sandboxed execution, and security audit |
| Session Bridges | Runtime-specific attachment, delivery, correlation, interruption, and honest resume/fork/fresh behavior |
| Environment providers | Physical local, Cloud, VPC, or on-premises execution, persistence, snapshots, isolation, and metering |

Dependency direction remains:

```text
SharedNet → RAC
SharedNet → SharedOS
SharedNet → Session Bridge adapters
SharedNet → Environment providers
```

RAC is not the durable Task state machine. SharedOS is not the product identity or network database. Session Bridges are not the network control plane.

## 10. Release sequence

### V1 — Website Launch

One outcome-shaped workflow: describe a website, answer an adaptive product interview, let an official Agent bench form a bounded organization, inspect the work and verification trace, interact with the generated preview, and receive a complete handoff. The default path is explicitly simulated; live Neon and Vercel writes remain credentialed, approved, and guarded.

### V1.5 — Local Organization

One Principal, one local host, persistent local Agents plus bounded spawned workers, isolated task workspaces, one RAC organization, one SharedOS authorization path, and one inspectable verified result.

### V2 — Connected Principals

Principal Connections, caller-relative Agent discovery, Cross-Principal inbox and acceptance, task-scoped Delegation Contracts, and the complete `ask @liyi → wait → SELF implement → optional reviewer` flow.

### V3 — SharedNet Cloud

Managed persistent execution routes, background wake-up, durable workspaces, snapshots, secret references, scale-to-zero, and honest local-to-Cloud continuation under the same Agent and Task identities.

### V4 — Enterprise and private runtime

Organization Principals, SSO, governance, policy, private networking, audit export, data residency, and VPC/on-premises Environment providers in the same SharedNet.

## 11. Non-negotiable invariants

1. **Principal is the ownership and persistent relationship boundary.**
2. **Agent identity is not a process, session, model, endpoint, or placement.**
3. **One Agent may expose multiple execution routes without becoming multiple Agents.**
4. **AgentCards are caller-relative and may hide fields or routes.**
5. **Discovery never implies recruitment, and recruitment never implies authority.**
6. **Persistent Connections are Principal-to-Principal; Agent collaboration is task-scoped.**
7. **Messages carry information, never authority.**
8. **RAC organizes only admitted candidates and stays inside immutable task bounds.**
9. **Experience may alter ranking after admission; it never creates authority.**
10. **Parallelism uses isolated mutable workspaces and an explicit integration path.**
11. **Durable Task state has one owner: SharedNet.**
12. **Execution origin, disclosure, authority, cost, and verification remain inspectable.**

## 12. Success

The product north star is:

> **Verified tasks completed through useful Agent organization per active Principal network per week.**

The core algorithm hypothesis is:

> For tasks that benefit from decomposition, specialist context, independent verification, or durable recovery, RAC-selected organization should improve verified outcome quality over the best single-Agent and naive fan-out baselines under matched cost or wall-clock budgets.

Candidate count, message volume, and graph complexity are not success metrics by themselves.

## 13. Detailed specification map

| Document | Owns |
| --- | --- |
| [Principals, Agents, and AgentCards](PRD/specs/01-principals-agents-agentcards.md) | Stable identity, ownership, Agent lifecycle, caller-relative cards, execution metadata |
| [Discovery, Connections, and Delegation](PRD/specs/02-discovery-connections-delegation.md) | Intra/Cross policy, exposure, Principal graph, recruitment, task contracts |
| [Candidate World and RAC](PRD/specs/03-candidate-world-rac.md) | Candidate construction, admission, Graph Intent, organization decisions, evaluation |
| [Tasks, Messages, and Recovery](PRD/specs/04-tasks-messages-recovery.md) | Durable lifecycle, attempts, messages, failure and recovery semantics |
| [Environments and Execution](PRD/specs/05-environments-execution.md) | Agent home, Task Environment, participant isolation, local/Cloud/private placement |
| [Runtime and Session Bridges](PRD/specs/06-runtime-session-bridges.md) | CC-Direct-style reachability, attachment, resume/fork/fresh, delivery safety |
| [Product Experience](PRD/specs/07-product-experience.md) | Onboarding, CLI/Skills, Console, Candidates, graph, policy UX |
| [System Boundaries and Architecture](PRD/specs/08-system-boundaries.md) | SharedOS/RAC/SharedNet ownership, data model, dependency direction |
| [Roadmap and Evaluation](PRD/specs/09-roadmap-evaluation.md) | Milestones, acceptance criteria, benchmark and metrics |
| [Website Launch V1](PRD/specs/10-website-launch-v1.md) | Runnable wedge, interview, official Agent bench, execution trace, preview, handoff, and provider safety |

Accepted decisions:

- [ADR 0001 — Principal-scoped network relationships](PRD/decisions/0001-principal-scoped-network.md)

Exploratory ideas:

- [Missions and autonomous organizations](PRD/ideas/missions-and-autonomous-organizations.md)
- [Agent lifecycle, promotion, and accumulated experience](PRD/ideas/agent-lifecycle-and-promotion.md)

## 14. Locked decisions

1. SharedNet is the parent product and durable network control plane.
2. SharedNet Cloud is a managed execution provider inside SharedNet.
3. Every SharedNet account maps to a Principal that may own multiple persistent Agents.
4. Persistent Connections are Principal-to-Principal.
5. Same-Principal and Cross-Principal are Candidate search and policy boundaries, not different coordination engines.
6. Each Agent owner controls whether and how that Agent is discoverable.
7. AgentCards are caller-relative; local, Cloud, and private execution are card metadata.
8. Agent-to-Agent work occurs under task-scoped Delegation Contracts.
9. RAC forms the organization; it does not own durable product lifecycle.
10. SharedOS owns capability authorization and bounded execution.
11. CC-Direct-style infrastructure is a Session Bridge, not a competing network layer.
12. Website Launch V1 proves the outcome-shaped RAC loop; V1.5 replaces deterministic execution with real local runtimes before Connected Principals and SharedNet Cloud.

## 15. Deferred questions

The following do not block the current V1/V1.5 release sequence:

- whether one Principal may contain nested team or project Principals;
- whether one Agent may eventually own multiple first-class home Environments;
- the exact local-to-Cloud snapshot and handoff protocol across runtime types;
- which Cross-Principal requests may be auto-accepted after repeated trust;
- how verified experience is shared, redacted, expired, or made portable;
- when a useful task-scoped worker should be promoted into a persistent Agent;
- whether a long-lived **Mission** should exist above Tasks for goals such as “start a company”;
- pricing boundaries among network membership, RAC intelligence, Cloud usage, and enterprise governance.

## 16. Product architecture decision

Proceed with SharedNet as the durable composer above RAC, SharedOS, runtime/session bridges, and Environment providers.

The complete product promise is:

> **Every Principal owns Agents. Every Task has a Candidate World. SharedNet turns the user's goal into the smallest authorized organization that can complete and verify the work — locally, through connected Principals, or in the Cloud.**
