# Predicted-cost re-review repair report

## Repairs

- Discovery resolves an admitted requester `SELF` from the immutable request snapshot before remaining-budget eligibility filtering. An attempt-excluded requester stops with `requester_excluded`; a requester that no longer fits the replan ceiling stops with `cost_budget_exhausted`. Neither case permits a specialist-only fallback.
- When a later replan abstains with `cost_budget_exhausted`, `CoordinationService` returns the prior completed plan, attempt summary, usage, and runtime evidence with `EXHAUSTED` / `cost_budget_exhausted`. Initial abstentions remain `ABSTAINED`.

## TDD evidence

Initial RED:

```text
PYTHONPATH=src python3 -m unittest tests.test_backends tests.test_service -v
Ran 45 tests
FAILED (failures=3, errors=1)
```

The failing counterexamples showed that discovery selected a specialist after the snapshot requester became ineligible, and that service returned an abstained replan instead of preserving the prior failure evidence.

Passing focused verification:

```text
PYTHONPATH=src python3 -m unittest tests.test_backends tests.test_service -v
Ran 45 tests
OK
```

Passing non-packaging verification:

```text
PYTHONPATH=src python3 -m unittest tests.test_models tests.test_primitives tests.test_backends tests.test_registry tests.test_service tests.test_codex_runtime tests.test_task_payload tests.test_cli tests.test_codex_live_e2e -v
Ran 117 tests
OK (skipped=1; opt-in live Codex E2E)
```
