# Final planner semantics hardening report

## Scope

Owned and changed only the shared planner helpers, four default planner modules, planner tests, and the approved design/implementation documents. Concurrent model, service, cost-helper, and Codex-runtime work was not staged or reverted.

## TDD evidence

RED command:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_backends -v
```

Observed before planner implementation: `Ran 28 tests`; `FAILED (failures=21, errors=9)`. The failures were the intended counterexamples: adaptive returned `no_positive_marginal_utility`/`participant_limit_reached` instead of completed coverage; every cost-emptied planner misclassified or admitted the request; rejection events omitted `admission_reason`; RGE selected `irrelevant-superstar`; peer-forum placed `self` after peers; epsilon-sized positive cost overages were selected; and participant organization mode was not yet exposed by the concurrent contract.

GREEN command after the contract worker's model/cost helpers landed:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_models tests.test_backends -v
```

Observed: `Ran 50 tests in 0.007s`; `OK`.

CLI/example smoke:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m sharednet.cli coord plan --mechanism rac-rge --request examples/four-agent-task.json
```

Observed plan: participant IDs `self`, `research-agent`, `architecture-agent`, `risk-agent`; modes `self`, `recruit`, `recruit`, `recruit`; stop reason `coverage_complete`; total predicted cost `0.35`. The checked-in four-participant plan therefore remains unchanged.

Formatting check:

```text
git diff --check
```

Observed: exit 0 with no output.

## Implemented planner semantics

- Shared eligibility keeps the stable `not_admitted` reason and the exact Candidate Snapshot `admission_reason`; individual cost rejection uses strict `Decimal(str(value))` helpers.
- A cost-rejected empty eligible set, including a retry snapshot that is also affected by attempt exclusions/policy denials, stops as `cost_budget_exhausted` across all four mechanisms.
- All cumulative choices use `fits_cost_budget` and `sum_costs`; exact decimal bounds pass while every positive overage fails.
- Every `ParticipantPlan` copies `candidate.mode` unchanged.
- RGE roots require positive required-capability contribution, so irrelevant or nonpositive candidates are rejected before root selection.
- Adaptive reports `coverage_complete` before participant-cap logic once its root covers the task.
- Peer forum emits the designated integrator at participant zero, peers afterward, integrator dependencies naming peers, and truthful peer-to-integrator `contributes_to` edges.

## Documented runtime contract

The design and implementation plan now distinguish organization authority (`RECRUIT`/`SPAWN`) from native Codex child-thread transport. They also require a fresh empty production working directory, exactly root-authored successful spawns, completed root-authored waits for the same children, marker-bound child contributions, and fail-closed rejection of disallowed data-only tools.
