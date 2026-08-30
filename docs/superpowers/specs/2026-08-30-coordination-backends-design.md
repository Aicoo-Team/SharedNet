# SharedNet Coordination Backends Design

**Status:** Approved for implementation by the 2026-08-30 request to proceed autonomously through local end-to-end testing.

## Goal

Add the first executable SharedNet back end for task-time coordination. Callers submit one bounded request through one interface, choose a registered coordination mechanism, and receive an inspectable plan and execution result. A live adapter must prove the path with one real Codex root and three native Codex subagents.

This is a local V0 slice. SharedNet still owns the durable Task and Candidate Snapshot; these coordination objects model one bounded run and do not become a second product state machine.

## Source material and reuse decision

The design uses two generations of the MIT-licensed RAC work:

- `Aicoo-Team/network-of-agents` contributes capability/trust discovery, verify-before-credit, failure exclusion, and rerouting.
- `Aicoo-Team/runtime-agent-coordination` contributes the narrow mechanism boundary, recursive `resolve` ordering, admission-before-ranking, contract attenuation, per-child budget reservations, RGE topology, append-only forum, verification-backed Beta experience, and the Codex JSONL runtime seam.

Three integration approaches were considered:

1. Install the current research repository directly. This maximizes literal reuse but couples SharedNet to evaluation fixtures, research-only imports, and a private alpha repository layout.
2. Reimplement the algorithms in the website branch's TypeScript application. This fits that UI but duplicates the reference Python behavior and makes the coordination service inseparable from a particular frontend worktree.
3. Vendor the small, stable Python primitives and adapt them behind a SharedNet-owned product interface. This preserves provenance, allows deterministic offline testing, and keeps research/evaluation code outside the runtime dependency graph.

Approach 3 is selected. Substantial borrowed logic carries the upstream MIT notice in `THIRD_PARTY_NOTICES.md` and source-level attribution comments.

## Public interface

`CoordinationBackend` has a stable `mechanism_id` and one operation:

```python
def plan(
    self,
    request: CoordinationRequest,
    *,
    excluded: frozenset[str] = frozenset(),
) -> CoordinationPlan: ...
```

`CoordinationService` owns registry lookup and execution:

```python
def plan(self, request: CoordinationRequest) -> CoordinationPlan: ...
def execute(self, request: CoordinationRequest, runtime: CoordinationRuntime) -> CoordinationResult: ...
```

The runtime boundary is deliberately separate:

```python
def execute(self, plan: CoordinationPlan) -> CoordinationResult: ...
```

This lets tests use a deterministic fake, while the local live path uses `CodexRuntime`. Backends decide organization; the runtime only executes the already bounded plan. `CandidateMode.RECRUIT` and `CandidateMode.SPAWN` express pre-admitted organization authority, while a native Codex child thread is only execution transport. Launching a child thread never escalates a `RECRUIT` participant to `SPAWN`, and the runtime may not rewrite the participant mode copied into the plan. When a runtime returns attributable failed participant IDs, the service asks the same backend for a new plan with those IDs excluded. Each executed attempt conservatively reserves its entire planned predicted cost, including failed attempts; each replan receives only the request-wide remaining `max_cost`. If no cost remains, execution returns `cost_budget_exhausted` without replanning. Each replan uses the original immutable Candidate Snapshot, consumes one explicit retry, and never admits a new candidate.

## Data contracts

All contracts are frozen dataclasses and JSON-safe through explicit `to_dict()` methods.

- `TaskSpec`: `task_id`, natural-language `goal`, required capabilities, acceptance criteria, and immutable input data.
- `CoordinationBudget`: positive wall-time, turn, depth, participant, retry, disclosure, and provider-neutral predicted-cost limits. `max_cost` defaults to `1.0` and is a positive finite ceiling on the sum of selected candidates' predicted costs; it never converts actual provider tokens into an invented price.
- `Candidate`: stable ID, mode (`SELF`, `RECRUIT`, or `SPAWN`), capabilities, admitted flag and reason, predicted quality/cost/latency/risk, and verified successes/failures.
- `CoordinationRequest`: task, sealed candidate tuple, budget, requested mechanism, and trace ID.
- `ParticipantPlan`: candidate ID, role, assignment, dependencies, selection reason, capabilities, the selected candidate's nonnegative finite `predicted_cost` (default `0` for compatible construction), and its unchanged organization `mode` (default `RECRUIT` for backward-compatible construction).
- `CoordinationPlan`: mechanism ID, task/trace IDs, attempt number, attempt-local exclusions, selected participants, graph edges, decision trace, runtime instructions, and an inspectable total predicted cost. It rejects participant totals above `budget.max_cost`.
- `AgentOutput`: one participant's attributable output and marker.
- `CoordinationResult`: terminal status, final plan, participant outputs, synthesis, runtime evidence, usage, attributable failed participant IDs, prior attempt summaries, and errors.

Construction validates hard bounds, unique candidate and participant IDs, known dependencies, admitted selected candidates, maximum participant/depth limits, and cumulative selected predicted cost. Admission is evaluated before ranking: a candidate whose individual predicted cost exceeds `max_cost` is hard-rejected with a trace reason before scoring, while a policy rejection retains the Candidate Snapshot's actual `admission_reason` alongside the stable `not_admitted` code. Every mechanism enforces individual and cumulative costs with exact decimal-domain comparison: an exact bound is valid and every positive overage is rejected without an epsilon. If individual-cost rejection leaves no eligible candidate, including after attempt exclusions or policy denials, the stop reason is `cost_budget_exhausted`; a genuinely empty policy/search result remains `no_eligible_candidates`. When cumulative cost alone leaves useful required work uncovered, the stop reason is also `cost_budget_exhausted`. Actual provider tokens remain execution evidence, not pricing input. A plan never mutates its request's candidate snapshot.

## Registered default mechanisms

The canonical registry order is:

```text
discovery-and-use
rac-rge
rac-adaptive
peer-forum
```

`rac-adpt` is accepted as a compatibility alias and resolves to canonical `rac-adaptive`; results always record the canonical identity.

### discovery-and-use

Filter admitted, individually affordable candidates with full required-capability coverage, then rank by capability coverage multiplied by verification-backed trust, minus normalized cost, latency, and risk. Resolve an admitted requester `SELF` from the immutable request snapshot, rather than the remaining-cost-filtered candidate set, and preserve its accountability: select the highest-ranked specialist whose cost plus `SELF` fits the cumulative ceiling. If the remaining ceiling no longer fits `SELF`, abstain with `cost_budget_exhausted`; if it is attempt-excluded, abstain with `requester_excluded`; if no pair fits, abstain with `cost_budget_exhausted`; and if the participant limit cannot hold the accountable pair, abstain with `participant_limit_reached`. Do not silently drop `SELF`. A self-specialist can still execute alone. This is the smallest specialist-use path and abstains explicitly when no candidate qualifies.

### rac-rge

Build an organization graph from a root rather than accepting a pre-authored workflow. A root must have positive task-specific contribution: reject candidates with no required-capability overlap or nonpositive utility, then choose the strongest positive contribution, favoring useful coverage so an irrelevant high-utility candidate cannot force a larger organization ahead of a complete specialist. Add only cumulatively affordable positive-utility candidates that contribute uncovered required capabilities. Attach each addition to the selected participant with the greatest capability overlap, respect depth, participant, and cost limits, and stop when coverage is complete, cost is exhausted, or no positive information gain remains. The trace records every rejection, expansion, or stop reason.

### rac-adaptive

Apply the reference RAC order: discover, hard-admit, rank, contract, execute, verify, and update experience. Planning uses marginal utility:

```text
quality + verified experience - cost - latency - risk - coordination overhead
```

Short linear tasks remain `SELF` when no extra candidate has positive utility. If `SELF` already covers every required capability, the planner reports `coverage_complete` before considering the participant cap, including at `max_participants=1`. Independent required capabilities can add only bounded, cumulatively affordable participants. If the participant cap is reached while required capabilities remain uncovered, the stop reason is `participant_limit_reached`; if affordability blocks useful work, it is `cost_budget_exhausted`. A verification failure excludes that candidate and causes the service to request a new plan from the same immutable snapshot within the retry budget; failure never creates authority or expands search radius.

### peer-forum

Select up to the participant limit from admitted, individually and cumulatively affordable candidates with complementary coverage. They receive an append-only forum discipline: announce focus, avoid duplicate work, challenge or extend peer findings, and preserve authorship. The designated `SELF` integrator, or the best selected generalist when no admitted `SELF` exists, is `participants[0]` because participant zero is the native runtime root synthesizer; peer participants follow. The integrator's dependencies name those peers and each truthful graph edge runs from peer to integrator with `contributes_to`. If uncovered capabilities remain at the participant cap, stop with `participant_limit_reached`; if useful coverage is blocked by cost, stop with `cost_budget_exhausted`. Forum evidence is an ordered transcript; reads and posts are attributable and bounded.

## RAC-derived primitives

The product layer vendors and adapts four small primitives:

- `verified_trust(candidate)`: centered Beta(1,1) posterior; unseen candidates receive no synthetic bonus.
- `rank_candidates(...)`: admission is complete before deterministic ranking; self-asserted performance metrics have no input.
- `LocalBudget`: atomically reserve, charge, and release a child budget; a child may not spend the parent's unreserved remainder.
- `AppendOnlyForum`: bounded authored posts with monotonically increasing sequence numbers and attributable reads.

The attenuation check enforces that child deadline, disclosure, allowed effects, and cost do not exceed the parent contract. These primitives are not durable stores; SharedNet may later persist their events around the run.

## Codex runtime adapter

`CodexRuntime` invokes the first working binary in this order: explicit constructor path, `SHAREDNET_CODEX_BINARY`, `/Applications/ChatGPT.app/Contents/Resources/codex`, then `PATH`.

The command uses only supported interfaces:

```text
codex --enable multi_agent -a never -s read-only
  exec --ephemeral --ignore-user-config --skip-git-repo-check
  --json --color never -m <model> <prompt>
```

The prompt contains the bounded plan, a fresh nonce, exact participant roles, and an instruction for the root to spawn exactly `N-1` native subagents in parallel, wait for them, and synthesize every marker. No worker needs file or shell access for the smoke task.

The production adapter launches Codex from a fresh, empty temporary working directory so repository instructions and ambient files cannot silently alter the data-only proof. It parses stdout as JSONL, preserves stderr separately, records the thread ID, final message, collaboration events, and `turn.completed` usage. Acceptance requires exactly `N-1` successful `spawn_agent` events authored by the root, child IDs attributable to those spawns, completed root-authored waits covering exactly those children, and marker-bound child contributions incorporated by participant zero. Spawn/wait are the only permitted collaboration controls for this data-only run; file, shell, web, or other disallowed tool activity fails closed. Timeout, nonzero exit, malformed or missing lifecycle evidence, missing markers, wrong participant count, wrong authorship, incomplete waits, or disallowed tool use returns a typed failure. The process receives `SIGTERM` on timeout and escalates to `SIGKILL` only within the request deadline.

Normal tests inject a process runner and never contact Codex. The live test is opt-in with `RUN_CODEX_E2E=1`, requires authenticated local runtime access, and must use the app-bundled binary when the Homebrew shim is broken.

## CLI

The local CLI is a thin client of the same service:

```text
sharednet coord list
sharednet coord plan --mechanism rac-rge --request examples/four-agent-task.json
sharednet coord run --mechanism rac-rge --request examples/four-agent-task.json
```

`list` emits canonical mechanisms and aliases. `plan` never invokes a model. `run` invokes the selected runtime and emits one JSON result. Invalid input, unknown mechanisms, unavailable runtime, and terminal coordination failures return nonzero status with a structured error on stderr.

## Errors and terminal states

The initial slice uses `accepted`, `partial`, `abstained`, `denied`, `exhausted`, and `failed`. It does not collapse abstention, denial, budget exhaustion, provider failure, and verification rejection into one boolean.

Exceptions are reserved for invalid caller contracts. Expected runtime/model outcomes become `CoordinationResult` values with trace evidence. No backend silently falls back to another mechanism.

## Testing

Offline tests use `unittest` and the Python standard library.

1. Contract tests validate immutable snapshots, bounds, graph/dependency integrity, and JSON stability.
2. Registry tests validate the four canonical identities, order, alias, and unknown-mechanism error.
3. Backend tests prove admission-before-ranking, capability/trust discovery, RGE expansion/stopping/depth, adaptive `SELF`/expansion/reroute, forum ordering, and deterministic decisions.
4. Runtime tests feed recorded JSONL through an injected fake process and validate command safety, empty-working-directory isolation, event parsing, exact root-authored successful spawns, completed waits, marker-bound child contributions, disallowed-tool rejection, token usage, failures, and timeout cleanup.
5. CLI tests validate list/plan with no provider calls.
6. The live end-to-end test submits a mocked incident-analysis data set to `rac-rge`, requires four planned participants, invokes the real Codex runtime, and asserts one root thread, exactly three successful root-authored native spawns, completed root-authored waits for the same children, four marker-bound contributions, no disallowed data-only tools, positive token usage, accepted terminal state, and a synthesis containing every worker contribution. This checked-in provider fixture sets a fixture-specific 600-second hard wall for root-plus-three execution variability, including transient provider transport failures; the product `CoordinationBudget` default remains 300 seconds.

Final verification runs all offline tests, compile/import checks, CLI plan smoke, and the opt-in real Codex end-to-end test.

## Deliberate non-goals

- No durable database, queue, endpoint presence, resume/fork support, or SharedOS grant implementation.
- No writable multi-agent checkout; the first live proof is read-only and data-oriented.
- No claim that the four default mechanisms are benchmark winners.
- No import of RAC evaluation fixtures, provider clients, or research result artifacts.
- No cross-Principal transport or policy creation from prompt text.
