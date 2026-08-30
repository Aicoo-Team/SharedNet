# Network Console V1

> **Status:** Implemented deterministic V1
>
> **Normative for:** the first runnable SharedNet experience, its three-page information architecture, demo Principal network, authority inbox, and usage ledger
>
> **Parent:** [`../../PRD.md`](../../PRD.md)

## 1. Outcome

> **Give SharedNet one outcome. A Planning Agent forms an organization from your Agents and trusted external Agents, asks only for authority-bearing decisions, and returns the work in the same conversation.**

The first task scenario is end-to-end website creation because it needs implementation, design, database, deployment, and independent verification expertise. Website Launch is a scenario inside the Network Console, not a separate product or staged wizard.

```text
one natural-language outcome
  ↓
Planning Agent forms Graph Intent
  ↓
owned Agents + connected-Principal candidates
  ↓
human decisions only where authority changes
  ↓
simulated result + organization + usage ledger
```

## 2. Demo truth boundary

V1 is deterministic. It implements the product state model and interaction contract but does not invoke models, remote Aicoo runtimes, Neon, or Vercel.

The interface must always display `DEMO NETWORK`. Simulated Agent work, provider operations, tokens, costs, and results must never be presented as externally executed facts. Existing provider adapters remain server-side reference boundaries and are not invoked by the V1 console.

## 3. Demo network

### 3.1 Your Principal

`@xisen` owns four persistent demo Agents:

| Agent | Role | Example route |
| --- | --- | --- |
| `@xisen/planner` | Task planning and candidate selection | Local Codex runtime |
| `@xisen/codex` | Canonical implementation and integration | Local task sandbox |
| `@xisen/research` | Product and API research | SharedNet Cloud |
| `@xisen/reviewer` | Independent verification | Isolated Cloud sandbox |

### 3.2 Connected Principal

`@aicoo` is a connected company Principal with five discoverable official demo AgentCards:

| Agent | Role |
| --- | --- |
| `@aicoo/web-builder` | End-to-end website specialist |
| `@aicoo/design-engineer` | Interface and interaction specialist |
| `@aicoo/neon` | Neon database specialist |
| `@aicoo/vercel` | Vercel deployment specialist |
| `@aicoo/quality` | Independent launch verifier |

The durable relationship is `@xisen ↔ @aicoo`. It permits caller-relative Agent discovery and task requests. It does not transfer Agent ownership or execution authority. Selecting one of these Agents creates a task-scoped recruitment request.

## 4. Information architecture

The V1 product exposes exactly three destinations.

### 4.1 `/chat`

The first screen is one multiline prompt labeled **What do you want done?** There is no preflight questionnaire, authored workflow, stage navigation, or Agent configuration.

After submission, one transcript shows:

1. the original outcome;
2. the Planning Agent's concise plan;
3. the Candidate World split by Principal;
4. simulated specialist contributions;
5. a tangible result and truth label;
6. links to required decisions;
7. task input, output, cached, total tokens, and normalized cost.

Planning is a participant in the conversation. It may ask a consequential follow-up later, but V1 demonstrates the direct path without a static interview.

### 4.2 `/network`

Network renders Principal boundaries before individual Agents:

- owned Agents are grouped inside `@xisen`;
- external Agents are grouped inside `@aicoo`;
- a solid Principal-level connection represents the durable relationship;
- dashed or explicitly labeled recruitment state represents task-scoped Agent use;
- a legend defines Intra-Principal and Cross-Principal;
- selecting an Agent reveals its AgentCard, runtime metadata, discoverability, capabilities, and usage on the same page.

Local, Cloud, and VPC are execution-route metadata. They are not separate Agent identities.

### 4.3 `/decisions`

Decisions is one authority inbox with Pending and Resolved sections. It supports:

| Type | Why it interrupts |
| --- | --- |
| Recruitment | Work or context would cross a Principal boundary |
| Inbound use | Another Principal wants to invoke an owned Agent |
| Authorization | A provider, secret, tool, or side effect needs a new grant |
| Plan choice | Two materially different paths require owner preference |

Every item states the requester, Agents in scope, consequence, and approve/deny actions. Resolution never deletes the item; it becomes an audit record.

## 5. Planning behavior

For the canonical website prompt, the deterministic Planning Agent:

1. keeps accountability with `@xisen/planner`, `@xisen/codex`, `@xisen/research`, and `@xisen/reviewer`;
2. discovers all five relevant Aicoo AgentCards;
3. requests task-scoped recruitment from `@aicoo`;
4. creates a separate Neon/Vercel authorization decision;
5. records a simulated launch package and independent verification result.

The demo intentionally illustrates the organization even while authority decisions are pending. Copy must state that actual external execution would wait for approval.

V1 is intentionally scoped to this canonical website-launch flow. The input remains conversational, but the interface names that scope and does not pretend a new submission is an arbitrary follow-up to an existing task.

## 6. Usage ledger

Every simulated Agent call creates an immutable usage entry:

```text
id
taskId
principalId
agentId
model
inputTokens
outputTokens
cachedTokens
costUsd
timestamp
```

Totals aggregate across task, Agent, Principal, and platform. Cached tokens are reported separately and are not added again to `totalTokens`; total means input plus output. V1 displays raw token counts and normalized USD and does not invent platform credits.

## 7. State and persistence

One versioned, serializable client state owns Principals, Agents, Connections, Tasks, recruitments, transcript entries, decisions, events, usage, and selected Agent. Schema V3 validates the complete nested state and cross-references before hydration. The state persists to local storage and is shared across routes; invalid, obsolete, or unavailable storage falls back to the canonical in-memory fixture.

Decision resolution recomputes the owning task and recruitment status. The transcript derives remaining-decision copy from current state, and Network labels task recruitment as `REQUESTED`, `RECRUITED`, or `DECLINED` without changing the durable Principal connection.

Pure domain functions must cover:

- initial fixture creation;
- prompt submission and organization formation;
- usage aggregation;
- decision resolution and audit events;
- Agent selection.

The retained Neon and Vercel adapters enforce `SHAREDNET_ENABLE_LIVE_CONNECTORS=true` and explicit action approval inside execution. Returned Neon connection details are redacted by default.

## 8. Visual and interaction requirements

- Warm daylight surface, dark ink, restrained signal color, and flat linework.
- No gradients, glass, chat bubbles, KPI card grids, or fake terminal streams.
- Three visible navigation destinations only.
- 44px minimum interactive targets, visible focus, keyboard submission, and reduced-motion support.
- Desktop and 390px layouts preserve Principal meaning and avoid horizontal page overflow.
- The frontend remains thin; network and authority semantics carry the product value.

## 9. Acceptance criteria

1. `/` redirects to `/chat`.
2. A new user can submit one task from one textarea.
3. The Planning Agent plan and Candidate World appear inside the transcript.
4. `@xisen` and `@aicoo` are visibly separate Principals with the specified Agents.
5. Principal connection and task-scoped recruitment are visually and verbally distinct.
6. All four decision types can be represented, resolved, and audited.
7. Usage is coherent in the global header, current task, each Principal, and each Agent.
8. Navigation and local persistence retain state across all three routes.
9. The demo truth boundary is visible before and after prompt submission.
10. Automated tests cover domain formation, usage aggregation, shell navigation, chat, network, and decision resolution.

## 10. Non-goals

- claiming that nine real Agent runtimes executed;
- making the generated website a production deployment;
- live Aicoo cross-Principal messaging;
- live Codex or Claude Code session attachment;
- provider OAuth or resource creation from the console;
- production identity, storage, billing, or learned RAC ranking;
- proving multi-Agent benchmark superiority.
