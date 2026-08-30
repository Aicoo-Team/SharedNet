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

## Coordination note

The planner worker was given the stable cost helper signatures and wired `ParticipantPlan(mode=candidate.mode)` in its separately owned common planner path. No backend, runtime, packaging, or documentation file was staged by this slice.
