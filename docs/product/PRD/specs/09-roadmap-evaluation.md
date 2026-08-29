# Roadmap and Evaluation

> **Status:** Working specification
>
> **Normative for:** release sequence, acceptance criteria, algorithm evaluation, product metrics, explicit non-goals
>
> **Parent:** [`../../PRD.md`](../../PRD.md)

## 1. Sequencing principle

SharedNet expands one Candidate World rather than launching disconnected products:

```text
V1  Website Launch with SharedNet official Agents
  ↓
V1.5  Intra-Principal local runtime candidates
  ↓
V2  Connected Principal candidates
  ↓
V3  Managed SharedNet Cloud execution routes
  ↓
V4  Organization governance and private providers
```

Every milestone must preserve the same Principal, Agent, AgentCard, Task, Delegation, trace, and authority model.

## 2. V1 — Website Launch

> **Give SharedNet a rough website idea; it asks enough product questions, forms the smallest useful official Agent organization, executes in dependency order, and returns a usable preview plus the work behind it.**

V1 is the implemented outcome-shaped wedge. It makes the coordination model tangible before live local and Cross-Principal runtime bridges are complete.

### 2.1 Required user loop

```text
1. Describe one website outcome
2. Answer seven material Product Agent questions
3. Confirm the Product Brief and acceptance boundary
4. Inspect the official Agents selected by RAC and why
5. Run the dependency-aware Mission
6. Receive an interactive preview, source, architecture, schema, manifests, and verification
```

### 2.2 Functional requirements

1. **Adaptive requirement discovery** — cover user, outcome, persistent data, access, visual direction, launch target, and observable acceptance.
2. **Persistent official Agent bench** — Product, Research, Architect, Builder, Neon, Vercel, and Quality AgentCards owned by SharedNet.
3. **RAC dependency graph** — research, architecture, optional database, build, deployment, independent verification, and handoff become runnable only when dependencies close.
4. **Truthful demo execution** — the real state machine and artifact generation work without credentials while provider resources remain visibly `SIMULATED`.
5. **Guarded live connectors** — provider tokens stay server-side; external creation requires explicit approval; ambiguous writes enter reconciliation rather than blind retry.
6. **Evidence-bearing handoff** — return preview, source, Product Brief, architecture, schema when needed, redacted infrastructure manifest, and verification evidence.
7. **Restorable Mission UI** — safe Mission state survives refresh without persisting provider credentials.

### 2.3 Acceptance criteria

1. A new user reaches the first material question from a rough outcome in one action.
2. SharedNet does not form an organization until all seven material decisions are clear.
3. A data-backed brief recruits `@sharednet/neon`; a non-persistent brief may omit it.
4. Deployment is never runnable before build, and verification is owned independently of the Builder.
5. Demo mode makes no provider network call and labels every infrastructure result `SIMULATED`.
6. Live mode fails closed without credentials or explicit approval and never returns credentials to the browser.
7. The final preview supports at least one complete interactive loop.
8. The handoff contains seven inspectable artifacts for the canonical data-backed Mission.
9. Desktop and narrow-screen layouts retain all critical actions without horizontal page overflow.
10. Automated tests cover interview readiness, RAC transitions, artifacts, connector safety, and the primary UI flow.

### 2.4 Explicitly out of V1

- claiming that generated demo code is a production-ready business;
- live Codex or Claude Code session attachment;
- arbitrary task families beyond the Website Launch archetype;
- Cross-Principal recruitment;
- SharedNet Cloud execution;
- public Agent discovery;
- learned routing or benchmark superiority claims;
- billing, enterprise SSO, or VPC deployment.

## 3. V1.5 — Local Organization

> **Give one local Agent a goal; SharedNet organizes eligible persistent Agents and fresh local workers owned by the same Principal into a bounded team and returns one verified, inspectable result.**

V1.5 is one Principal and one local host. It replaces deterministic official-Agent execution with real runtime reachability, isolation, durability, and authorization before expanding network radius.

### 3.1 Required user loop

```text
1. Install and start SharedNet locally
2. Create or authenticate one Principal
3. Attach persistent Codex and/or Claude Code Agents
4. Set each Agent's Intra-Principal exposure
5. Register approved local SpawnTemplates
6. Give one natural-language goal
7. Produce TaskSpec + Graph Intent
8. Query Intra-Principal Candidate World and evaluate admission
9. Seal Candidate Snapshot with accepted/rejected reasons
10. RAC chooses SELF / same-Principal RECRUIT / SPAWN
11. SharedOS authorizes each bounded action
12. Participants work in read-only or isolated task workspaces
13. One integrator produces the canonical result
14. SharedNet renders organization, trace, evidence, and verification
```

### 3.2 Functional requirements

1. **Durable local host** — persist Principal, Agents, AgentCards, home/Task Environment metadata, Sessions, candidates, Tasks, attempts, messages, events, and results across restart.
2. **Codex and Claude Code bridges** — attach, report capabilities, deliver, resume/fork/fresh when supported, stream replies, interrupt, and report honest failure.
3. **Intra-Principal exposure** — hidden Agents are excluded from autonomous Candidate World; exposed Agents produce caller-appropriate cards.
4. **Local Candidate World** — include `SELF`, exposed persistent Agents, eligible execution routes, and approved SpawnTemplates.
5. **Graph Intent** — preserve exact identities, required ordering, optional review, budgets, and stopping conditions without a fixed authored graph.
6. **RAC composition** — admission, selection, bounded organization, verification, reroute, abstain, and terminal ledger.
7. **SharedOS composition** — trusted AccessContext, grant compilation, filtered tools, point-of-use authorization, and audit.
8. **Workspace safety** — separate local worktrees/sandboxes and one explicit integration path.
9. **Recovery** — acknowledged Tasks survive coordinator/runtime restart with attempt and checkpoint lineage.
10. **Minimal CLI and Console** — onboarding, Agents, exposure, candidates, Tasks, generated graph, trace, and recovery.

Same-Principal Agent pairs do not require durable Connection objects. Principal policy plus per-Agent exposure controls discovery; Delegation remains task-scoped.

### 3.3 Acceptance criteria

1. A new user attaches two persistent local Agents, or one Agent plus one reusable SpawnTemplate, within ten minutes.
2. The owner can hide one Agent from autonomous Intra-Principal discovery without deleting or pausing it.
3. A prompt with one required collaborator, one dependency, and one optional review becomes valid inspectable Graph Intent.
4. RAC forms an organization with at least two participants on a benchmark task where decomposition or specialization is justified and records why each was selected.
5. On a short linear benchmark, RAC stays with `SELF` and explains why additional Agents would not help.
6. Two local Codex runtime workers can run concurrently without writing the same checkout.
7. A live Codex or Claude Code Session receives a correlated request and returns a reply without transcript-file mutation.
8. SharedOS denies a capability outside the Task contract with a readable reason.
9. Killing a runtime or SharedNet process does not lose an acknowledged Task; recovery creates attributable attempt lineage.
10. Replaying the same idempotency key does not create a duplicate Task or Delegation.
11. A successful Task records one integrated result, verification evidence, execution origins, costs, and complete organization graph.
12. The benchmark harness compares RAC with best-single-Agent and naive fan-out baselines under matched budgets.

### 3.4 Explicitly out of V1.5

- Cross-Principal recruitment and recipient approval;
- SharedNet Cloud execution;
- public Agent discovery;
- learned routing in production;
- recurring schedules;
- arbitrary multi-writer merge resolution;
- billing, enterprise SSO, or VPC deployment;
- unrestricted shell, browser, package-manager, network, or external side effects from inbound messages.

## 4. V2 — Connected Principals

V2 expands Candidate World through explicit Principal relationships:

- verified Principal handles and Connection requests;
- directional Connection templates, expiry, suspension, and revocation;
- per-Agent Cross-Principal exposure and caller-relative AgentCards;
- field-level and execution-route-level visibility;
- Cross-Principal durable inbox and recipient approval;
- task-scoped Delegation Contracts and attenuated SharedOS grants;
- CC-Direct-style delivery to live/resumable recipient-owned Sessions;
- private team discovery and recipient refusal;
- origin restriction propagation and cross-principal trace;
- the complete `ask @liyi → wait → SELF implement → optional reviewer` flow.

**Exit condition:** one real Agent recruits an exposed Agent owned by a connected Principal, receives contract-bounded analysis, continues its own work, conditionally adds review, and returns one verified result without either person sharing runtime credentials or workspaces.

Public discovery is not required for V2.

## 5. V3 — SharedNet Cloud

V3 adds managed execution routes:

- persistent isolated Agent home and Task workspace support;
- task-level runtime plus participant isolation;
- background wake-up and durable remote inbox;
- secret references, egress rules, snapshots, audit, and metering;
- scale-to-zero compute;
- Cloud routes inside caller-relative AgentCards;
- detach local Task and continue under the same Agent and Task identities;
- explicit resumed/forked/fresh semantics.

**Exit condition:** a user detaches an eligible local Task, the same Agent continues through a Cloud route with honest state-transfer semantics, and the verified result returns to the same trace and inbox.

## 6. V4 — Enterprise and private runtime

- company or team Principal model;
- SSO, role administration, governance, retention, and audit export;
- private VPC/on-premises Environment providers;
- private networking, data residency, and compliance controls;
- organization-scoped exposure and verified experience;
- hybrid local, Cloud, and private Candidate World under policy.

**Exit condition:** one enterprise Principal operates employee local Agents, SharedNet Cloud Agents, and private VPC Agents in one governed network and trace model.

## 7. Core algorithm hypothesis

> For tasks that benefit from decomposition, specialist context, independent verification, or durable recovery, RAC-selected organization should improve verified outcome quality over the best single-Agent baseline and naive fan-out under matched cost or wall-clock budgets.

The hypothesis is task-conditional. SharedNet must also demonstrate that it avoids coordination when one Agent is better.

### 7.1 Benchmark families

The evaluation set should include:

- short linear tasks where `SELF` should win;
- parallel independent investigations;
- dependent subproblems requiring staged integration;
- specialist-context tasks where one persistent Agent has unique useful state;
- high-risk tasks with externally checkable outcomes;
- long-running tasks with injected runtime or host failure;
- tasks where extra Agents introduce harmful duplication or conflict;
- tasks where no candidate should be admitted and abstention is correct.

### 7.2 Baselines

Compare:

1. best available single Agent;
2. naive fixed fan-out and aggregation;
3. static pre-authored workflow when applicable;
4. SharedNet Candidate World + RAC adaptive organization.

Budgets, models, tools, context, and wall-clock or cost ceilings must be matched and reported.

### 7.3 Evaluation measures

- independently verified success and quality;
- gain over best-single-Agent;
- cost and wall-clock latency;
- useful versus wasted delegations;
- communication and integration overhead;
- workspace conflicts and merge failures;
- recovery and abstention quality;
- verifier independence and calibration;
- human approvals and manual interventions;
- authorization denials and disclosure incidents;
- calibration of quality, cost, and latency estimates.

## 8. Product metrics

North star:

> **Verified tasks completed through useful Agent organization per active Principal network per week.**

Supporting metrics:

- median install-to-first-attached-Agent time;
- median time to first multi-participant verified Task;
- percentage of eligible Tasks where RAC correctly stays with `SELF`;
- percentage of acknowledged Tasks surviving runtime or host restart;
- same-Principal and Cross-Principal recruitment completion rate;
- percentage of denied actions with readable reasons;
- percentage of runs with complete execution origin and Session mode;
- Cloud detach/continue success once shipped;
- percentage of accepted results with traceable evidence.

Counter-metrics:

- candidate, Agent, or Message volume grows while verified outcomes do not;
- coordination cost grows without quality or latency gain;
- users cannot tell which Principal owned a participant or where it ran;
- discoverability is mistaken for authority;
- stale Session context increases failure;
- local parallelism increases corruption or merge burden;
- retries hide systematic failures;
- Cloud placement fragments Agent identity or Task state.

## 9. Product non-goals

| SharedNet is not | Boundary |
| --- | --- |
| A social feed for Agents | Relationships exist to enable accountable work, not engagement |
| A global public directory by default | Exposure, relationship, reachability, recruitment, and authority remain separate |
| A chat shell with many bots | Messages carry information; Tasks carry durable responsibility |
| A drag-and-drop workflow builder | Graph Intent expresses bounds; organization emerges at runtime |
| A hosted-Agent-only product | Local, Cloud, and private routes participate in the same network |
| An Agent clone/sync product | One Agent stays one identity across routes |
| A replacement for Codex or Claude Code | Existing harnesses remain runtime endpoints |
| A second authorization engine | SharedOS owns point-of-use enforcement |
| An infinite transcript as memory | Sessions are renewable; durable knowledge is promoted explicitly |
| Concurrent mutation of one checkout | Parallel work uses isolation and explicit integration |
| Multi-Agent fan-out as a goal | Extra participants require expected task-specific value |
