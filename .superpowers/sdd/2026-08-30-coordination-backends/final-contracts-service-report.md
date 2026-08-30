# Final contracts/service hardening report

## Scope

- Added exact predicted-cost helpers in `coordination/costs.py` using `Decimal(str(value))`, strict `<=`, and no epsilon.
- Made model cost bounds exact, accepted a positive `1e-13` budget, rejected unknown budget keys, rejected multiple admitted SELF candidates, and preserved candidate mode in serialized participant plans.
- Added a typed `PlanValidationError` boundary before runtime execution. It validates backend/task/trace/exclusions/budget/task-payload authority and every selected candidate's identity, admission, exclusion, mode, capabilities, and predicted cost against the immutable request snapshot.
- Preserved the last completed attempt on every post-attempt planning abstention and attached the terminal abstained plan and reason under `runtime_evidence.terminal_replan`.

## TDD evidence

RED, before production changes:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_models tests.test_service -v
Ran 50 tests in 0.016s
FAILED (failures=8, errors=2)
```

The failures reproduced exact-overage tolerance, fail-open budget fields, missing participant mode, duplicate admitted SELF authority, tiny-cost RuntimeError, post-attempt evidence loss, and the absent typed service boundary. The missing new costs module produced one of the expected errors.

GREEN, focused:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_models tests.test_service -v
Ran 50 tests in 0.030s
OK
```

Fresh final focused run after refactoring:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_models tests.test_service -q
Ran 50 tests in 0.031s
OK
```

Broader non-runtime suite, excluding the separately owned packaging test while it was under concurrent repair:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_backends tests.test_cli tests.test_models tests.test_primitives tests.test_registry tests.test_service tests.test_task_payload -v
Ran 100 tests in 0.108s
OK
```

`compileall` on all owned Python paths and `git diff --check` on all owned paths also passed with no output.

One final boundary audit found the deadline could expire after a backend returned a post-attempt abstention but before its terminal replan evidence was attached. A new focused test reproduced the missing `terminal_replan` key, then passed after preserving the abstention evidence while retaining wall-time exhaustion as the terminal error:

```text
RED:   Ran 1 test in 0.014s — FAILED (errors=1, KeyError: terminal_replan)
GREEN: Ran 1 test in 0.009s — OK
Fresh focused regression: Ran 51 tests in 0.018s — OK
```

## Coordination note

The planner worker was given the stable cost helper signatures and wired `ParticipantPlan(mode=candidate.mode)` in its separately owned common planner path. No backend, runtime, packaging, or documentation file was staged by this slice.

## Evidence-lineage and numeric follow-up

The final scoped re-review identified that the bounded attempt history retained status and usage but dropped each runtime result's raw outputs, partial synthesis, and provider evidence. `AttemptSummary` now immutably retains and serializes outputs, synthesis, and runtime evidence in addition to its existing failed IDs, usage, status, and error. The service populates every field before retrying, so a final accepted result carries the full evidence from earlier failed/partial attempts. `CoordinationResult` rejects attempt histories longer than `max_retries + 1`.

The shared positive/nonnegative numeric validators now require every accepted `int` or `float` to convert to a finite float. This rejects values such as `10**400` at construction for wall time, max cost, candidate predictions, and participant predicted cost, before any planner/service float conversion. Exact Decimal cost comparison and valid `1e-13` budgets remain unchanged.

Follow-up RED:

```text
Attempt evidence + huge numeric values:
Ran 3 tests in 0.005s
FAILED (failures=1, errors=2)

Attempt-history bound:
Ran 1 test in 0.001s
FAILED (failures=1)
```

Follow-up GREEN:

```text
Focused new behaviors: Ran 4 tests in 0.009s — OK
Fresh models/service: Ran 55 tests in 0.050s — OK
Relevant planners: Ran 28 tests in 0.008s — OK
Full non-runtime suite: Ran 106 tests in 0.236s — OK (skipped=1)
```

Fresh `compileall` and owned-path `git diff --check` also completed with no output.
