# Cost-budget final-fix report

## Scope

- Base observed before this fix wave: `176b45bf6ab1178ea68cdcfc8ce0498bff20cb9e`.
- Updated only the assigned coordination model, shared planner helpers, four planner backends, fixtures/tests, example request, and design/plan documentation.
- Preserved concurrent service, runtime, CLI, packaging, licensing, and build changes.

## Contract and behavior

- `CoordinationBudget.max_cost` defaults to `1.0`; it is finite, positive, provider-neutral, and applies to predicted costs only.
- Selected candidates retain `predicted_cost` in their `ParticipantPlan`; `CoordinationPlan.total_predicted_cost` is serialized and plan construction rejects an over-budget aggregate.
- Individually unaffordable candidates are rejected before ranking. All default planners check cumulative affordability before selection, allow exact-bound selections, and report `cost_budget_exhausted` when useful work remains cost-blocked.
- Discovery drops the requester-integrator when its addition would exceed the ceiling. Adaptive and peer-forum truthfully report the participant limit when it leaves required work uncovered.

## TDD evidence

Initial RED command:

```text
PYTHONPATH=src python3 -m unittest tests.test_models tests.test_backends -v
```

Observed expected failures for the missing budget field, participant cost, plan total, and planner enforcement: one assertion failure and nine errors.

Passing focused verification:

```text
PYTHONPATH=src python3 -m unittest tests.test_models tests.test_backends -v
# 33 tests, OK

PYTHONPATH=src python3 -m unittest tests.test_task_payload tests.test_cli -v
# 8 tests, OK
```
