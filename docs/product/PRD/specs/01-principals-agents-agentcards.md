# Principals, Agents, and AgentCards

> **Status:** Working specification
>
> **Normative for:** identity, ownership, persistent Agent lifecycle, AgentCard projection, execution-route metadata
>
> **Parent:** [`../../PRD.md`](../../PRD.md)

## 1. Purpose

This specification separates the durable network identity of an Agent from the processes, sessions, machines, and providers through which it executes.

The model must support all of the following without cloning identity:

- several persistent Agents owned by one SharedNet account;
- one Agent reachable through local, SharedNet Cloud, and private routes;
- caller-specific disclosure of capabilities and routes;
- fresh task workers that do not become durable network members;
- runtime sessions that may be resumed, forked, replaced, or lost.

## 2. Principal

Every SharedNet account maps to one stable **Principal**.

A Principal is the root boundary for:

- ownership and administration;
- network relationships;
- discovery and recruitment policy ceilings;
- billing and budgets;
- audit and retention;
- Environment and runtime registration;
- user or organization approval policy.

A Principal may represent an individual in V0/V1. Team, company, and nested project models are deferred, but they must preserve the same ownership and policy boundary.

Illustrative identifiers:

```text
Principal ID       principal:xisen
Principal handle   @xisen
```

Canonical IDs are immutable and never recycled. Human-readable handles may be renamed with alias history.

## 3. Persistent Agent

A persistent **Agent** is an accountable service identity owned by exactly one Principal.

```text
@xisen
├── @xisen/coding
├── @xisen/research
└── @xisen/reviewer
```

An Agent owns or references:

- immutable Agent ID and mutable handle;
- owner Principal ID;
- description, capabilities, and accepted task classes;
- private policy source and exposure rules;
- logical home Environment and accepted durable memory;
- verified experience and provenance;
- eligible runtime sessions and execution routes;
- lifecycle state such as active, paused, or retired.

An Agent is not:

- one model invocation;
- one operating-system process;
- one Codex or Claude Code session;
- one machine or VM;
- one local or Cloud placement;
- every worker spawned during a task.

### 3.1 Product Principal versus delegated security actor

In the SharedNet product model, **Principal** means the account-level ownership and persistent relationship root. Agents, Sessions, endpoints, and participants still authenticate and may be represented as security subjects inside SharedOS, but they act through credentials and grants delegated from an owner Principal and a Task.

This terminology distinction prevents an implementation-level security identity from accidentally gaining product-level ownership, billing, or Connection semantics.

### 3.2 Persistent Agent versus task participant

A live runtime becomes a persistent Agent only when its owner explicitly attaches or promotes it into an accountable service boundary.

A fresh worker created by `SPAWN` receives a task-scoped `ParticipantID`. It does not receive a durable public handle, independent relationships, or cross-task memory by default.

A persistent Agent recruited through `RECRUIT` keeps its identity, owner, Environment, and policy. Recruitment does not transfer ownership.

## 4. AgentCard

An **AgentCard** is a versioned, caller-relative projection used for discovery, admission, routing, and product display.

The private Agent record is the source. `AgentCard(viewer, task_context)` is a filtered materialization of that source under:

```text
owner exposure policy
× viewer Principal relationship
× task origin and purpose
× field and route visibility
× current availability
```

There is no globally complete card that every caller can retrieve.

### 4.1 Card fields

A projected AgentCard may contain:

```yaml
agent_id: agent:xisen:7Qx91L
handle: "@xisen/coding"
principal_id: principal:xisen
display_name: Xisen's Coding Agent
capabilities:
  - code_implementation
  - architecture_review
accepted_tasks:
  - repository_change
availability:
  state: available
  updated_at: 2026-08-26T10:00:00Z
recruitment:
  posture: request
  max_duration: task_policy
experience:
  verified_summary: caller_visible_projection
execution:
  - route_id: route:local:codex
    provider: local
    runtime: codex
    background: false
    context_affinity: high
    availability: online
    visibility: intra_principal
  - route_id: route:cloud:codex
    provider: sharednet_cloud
    runtime: codex
    background: true
    context_affinity: medium
    availability: scale_to_zero
    visibility: connected_principals
card_version: 12
```

This schema is conceptual. Transport fields may evolve, but the semantic separation is required.

### 4.2 Caller-relative views

The same Agent can produce different projections:

| Viewer | Typical visible card |
| --- | --- |
| Owner/admin | Full policy, private metadata, all execution routes, diagnostics |
| Same-Principal Agent | Capabilities and routes allowed by Intra-Principal policy |
| Connected Principal | Public capability subset, recruitment posture, eligible Cloud/private routes |
| Allowlisted Principal | Explicitly selected fields and routes |
| Unrelated Principal | No card unless later public policy allows it |

Field visibility and route visibility are independent. A connected caller may discover an Agent while its local route remains hidden.

### 4.3 Card freshness and truthfulness

- Stable identity and owner fields come from durable SharedNet state.
- Presence, latency, session freshness, and availability are time-bounded claims.
- A route with an expired lease must not appear online.
- A runtime capability unsupported by its adapter must not be advertised.
- Verified experience must carry provenance and must not be represented as a permission.
- Cards should be signed or integrity-bound to their issuer and version in cross-principal transport.

## 5. Execution routes

An execution route describes an eligible place and runtime through which an Agent can act. It is metadata on the AgentCard and a control-plane endpoint internally; it is not a separate product identity.

A route may describe:

- provider: local, SharedNet Cloud, private VPC, or on-premises;
- runtime and model policy;
- online, resumable, background, or scale-to-zero availability;
- expected latency and cost class;
- context and data affinity;
- workspace and Environment compatibility;
- egress, secret, and tool ceilings;
- caller visibility and recruitment restrictions.

Route selection occurs after the semantic Agent is selected and before execution begins:

```text
select Agent
  ↓
filter visible and authorized execution routes
  ↓
choose route by context, availability, cost, latency, and policy
  ↓
bind endpoint/session lease
```

A task may retry through another eligible route under the same Agent ID only if Task policy permits and session/environment semantics remain honest.

## 6. Session relationship

A Session is a runtime-specific working context attached to an Agent and Environment. It may be:

- **resumed** for a continuing problem;
- **forked** for related or divergent work;
- **fresh** when context is stale, unrelated, unavailable, or high-risk.

The chosen mode must be visible in the Task trace. Important knowledge must be promoted into durable Agent/Environment artifacts rather than depending on an infinitely growing transcript.

## 7. Lifecycle

```text
draft → active ↔ paused → retired
```

- `draft`: owned but not eligible for Candidate World.
- `active`: eligible according to exposure, availability, and admission policy.
- `paused`: retains identity and state but refuses new autonomous recruitment.
- `retired`: no new work; historical identity, artifacts, and audit remain resolvable.

Deleting or renaming a runtime route does not retire the Agent. Retiring an Agent invalidates future recruitment but does not erase prior Task provenance.

## 8. Required invariants

1. Every persistent Agent has exactly one owner Principal.
2. Agent identity never derives from a mutable runtime-native session ID.
3. One Agent may advertise several routes without becoming several Agents.
4. One process or session does not automatically become a persistent Agent.
5. AgentCard projection may only remove or attenuate owner policy; it cannot widen it.
6. Exact addressability does not bypass card exposure or task admission.
7. Runtime and placement claims are time-bounded and auditable.
8. Route selection must remain visible in the Task trace.
