# Candidate World and Runtime Agent Coordination

> **Status:** Working specification
>
> **Normative for:** Candidate World, Candidate Snapshot, Graph Intent, `SELF`/`RECRUIT`/`SPAWN`, RAC organization, verification, experience
>
> **Parent:** [`../../PRD.md`](../../PRD.md)

## 1. Product responsibility

The user gives SharedNet a goal. SharedNet decides whether the task should remain with one Agent, branch into parallel workers, recruit a persistent Agent, add independent verification, or create durable checkpoints.

This autonomy remains bounded by:

- the user's explicit identities, sequence, prohibitions, and acceptance criteria;
- Principal policy and allowed Candidate radius;
- Agent exposure and recruitment policy;
- SharedOS authority;
- time, cost, turn, depth, active-participant, disclosure, and side-effect budgets.

RAC must form the **smallest useful organization**, not the largest available one.

## 2. Candidate World

The **Candidate World** is SharedNet's durable, continuously updated, permission-aware index of everything that could potentially participate in a task:

- the requesting Agent (`SELF`);
- the Principal's exposed persistent Agents;
- eligible local, Cloud, or private execution routes for those Agents;
- approved spawn templates;
- Agents exposed by connected or explicitly selected Principals;
- later, public candidates if that product surface is deliberately introduced.

It is not a static worker list and not a claim that every indexed candidate may be used.

Conceptually:

```text
Candidate(task)
= Agent or SpawnTemplate
× caller-visible AgentCard
× Environment compatibility
× connection and delegation path
× availability and session freshness
× context affinity
× expected quality, cost, and latency
× trust and verified experience
× effective authority
```

## 3. Candidate Snapshot

At the start of one coordination attempt, SharedNet:

1. applies Task Search Scope;
2. requests caller-relative AgentCards;
3. evaluates admission;
4. records admitted and rejected candidates with reasons;
5. seals an immutable **Candidate Snapshot** for that RAC run.

RAC ranks only the admitted subset. Dynamic presence changes may trigger a new Task attempt and new snapshot; they must not silently mutate an in-flight decision ledger.

The product must be able to explain:

```text
Who or what was considered?
Which card projection was visible?
Why did each candidate pass or fail admission?
Where could it run?
What context and authority could it receive?
Why was it selected, skipped, rerouted, or replaced?
```

## 4. Candidate modes

| Mode | Meaning | Example |
| --- | --- | --- |
| `SELF` | Continue with the requesting persistent Agent | Current Codex implements the change |
| `RECRUIT` | Ask an existing persistent Agent under a Delegation Contract | Ask `@liyi/api` for specialized analysis |
| `SPAWN` | Create a bounded task-scoped worker from an approved template | Start two fresh independent reviewers |

Execution route and Session selection happen after the mode and Agent/template choice. They are not additional RAC modes.

`RECRUIT` is not synonymous with remote. Another persistent Agent on the same laptop and an Agent owned by another Principal use the same semantic mode with different policy, transport, and acceptance paths.

## 5. Admission before ranking

A candidate must pass hard checks before quality or experience ranking:

- stable identity or valid SpawnTemplate;
- lifecycle and route validity;
- requester search scope and provider exposure;
- Principal relationship where required;
- acceptance or preauthorization posture;
- Environment, workspace, and runtime compatibility;
- disclosure and capability ceiling;
- origin restrictions;
- availability, budget, and deadline;
- required approval state.

Experience, reputation, and predicted quality may influence ranking only after admission. They never create authority.

## 6. Graph Intent

SharedNet compiles a natural-language request into:

- a `TaskSpec` with goal, evidence, acceptance criteria, and bounds;
- hard organizational constraints such as exact collaborators or ordering;
- soft preferences such as optional review;
- autonomy bounds for cost, time, authority, recursion, retries, and stopping.

```text
Graph Intent = what must or may happen
Organization Graph = what actually happened
```

### 6.1 Signature example

Input:

> 先联系一下 Liyi 的 Agent，让它分析 API 设计；拿到回复以后，你自己完成实现。如果有必要，再找 reviewer。

Normalized intent:

```yaml
goal: implement the requested API change
search_scope:
  intra_principal: true
  selected_principals: [principal:liyi]
organization:
  - mode: RECRUIT
    principal: principal:liyi
    capability: api_design
    role: api_design_advisor
    required: true
  - mode: SELF
    role: implementer
    after: api_design_advisor
  - role: reviewer
    allowed_modes: [RECRUIT, SPAWN]
    required: false
    trigger: risk_or_uncertainty_high || verification_failed
limits:
  max_active_participants: 3
  max_delegation_depth: 2
  deadline: task_defined
  cost_budget: task_defined
```

Exact Agent or Principal mentions, required ordering, and explicit prohibitions become hard constraints. “If necessary” becomes a bounded trigger policy, not unconditional fan-out.

Prompt parsing may narrow authority but can never create a Connection, grant, exposure right, or recipient acceptance.

## 7. Organization decision policy

RAC evaluates why extra organizational structure would help:

| Task property | Default action | Required evidence before expanding |
| --- | --- | --- |
| Short, linear, low-risk | `SELF` | No expected gain from coordination |
| Truly independent branches | Parallel `SPAWN` or `RECRUIT` | Decomposition has limited shared mutable state and meaningful wall-clock or coverage gain |
| High-risk and independently verifiable | Add verifier | Verification signal is sufficiently independent and actionable |
| Special context, ownership, or expertise | `RECRUIT` persistent Agent | Candidate has context or capability unavailable to `SELF` at acceptable disclosure cost |
| Long-running or failure-prone | Checkpoints and recoverable attempts | Work can resume from durable state with attributable lineage |

Multiple Agents are not assumed to outperform one Agent on every task. RAC must account for communication, duplicated reasoning, integration, disclosure, and verification overhead.

### 7.1 Organization policies

Users or hosts may choose a high-level posture without drawing a workflow:

- **Solo:** prefer `SELF`; recruit only when required.
- **Balanced:** expand when expected verified-quality or latency gain exceeds overhead.
- **Thorough:** encourage independent analysis and verification within budget.
- **Custom:** application or enterprise policy supplies explicit bounds.

The default should remain Balanced and should not require the user to understand coordination internals.

## 8. Bounded recursion

A recruited Agent may request further help only if the Delegation Contract explicitly permits onward delegation.

Every recursive edge inherits and may only narrow:

- task origin;
- disclosure ceiling;
- authority ceiling;
- remaining budget and deadline;
- maximum depth and active-participant count;
- verification and evidence obligations.

Recursive fan-out with no expected information gain is a policy failure. Hitting a depth, cost, or time budget produces an explicit terminal reason rather than an unbounded retry loop.

## 9. Verification and failure recovery

RAC may:

- verify directly using task evidence;
- recruit or spawn an independent verifier;
- reroute to another admitted candidate;
- retry from a checkpoint;
- abstain when no candidate can satisfy the contract;
- escalate to the user when interpretation, authority, or evidence remains insufficient.

The same Agent's self-review must not automatically count as independent verification. Independence is a property of role, context, evidence, and failure correlation—not merely another prompt.

## 10. Experience

SharedNet persists verification-backed observations through RAC experience ports:

- candidate quality and calibration;
- cost and latency estimates;
- failure and recovery patterns;
- useful collaboration pairs and task classes;
- verifier effectiveness;
- disclosure and integration overhead.

Experience can improve future ranking and policy. It cannot admit an otherwise forbidden Agent or enlarge authority.

## 11. Evaluation

Every benchmark set should compare under matched cost or wall-clock budgets:

1. best available single Agent;
2. naive fixed fan-out and aggregation;
3. static pre-authored workflow when relevant;
4. SharedNet Candidate World + RAC adaptive organization.

Measure:

- independently verified task success;
- quality gain over best-single-Agent;
- wall-clock latency and cost;
- useful versus wasted delegations;
- integration conflicts;
- recovery and abstention quality;
- human approvals and interventions;
- disclosure and authorization incidents;
- calibration of candidate estimates.

## 12. Required invariants

1. RAC receives an immutable admitted Candidate Snapshot per attempt.
2. RAC never widens search radius, disclosure, or authority.
3. Exact Graph Intent constraints survive planning and rerouting.
4. Added participants require a task-specific expected benefit.
5. Every RAC run has explicit time, cost, turn, depth, retry, disclosure, and participant bounds.
6. Experience affects ranking only after admission.
7. The generated organization and every decision reason remain inspectable.
