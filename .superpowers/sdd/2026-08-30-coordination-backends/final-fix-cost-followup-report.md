# Request-wide predicted-cost follow-up report

## Decision

An executed runtime attempt conservatively consumes its plan's full `total_predicted_cost`, even if that runtime result is attributable failure. Predicted cost remains provider-neutral planning data; no provider-token price conversion is introduced.

## Fixes

- The service now passes only the request-wide predicted-cost remainder to each replan and returns `EXHAUSTED` / `cost_budget_exhausted` before a retry when no cost remains.
- Discovery-and-use preserves an admitted requester `SELF`: it selects the highest-ranked complete specialist that can fit with the requester, or abstains truthfully instead of silently dropping accountability.
- Adaptive evaluates positive marginal utility before cumulative affordability so the stop reason reflects the actual rejection.
- Design and plan global constraints document the request-wide reservation rule.

## TDD evidence

Initial focused RED:

```text
PYTHONPATH=src python3 -m unittest tests.test_backends tests.test_service -v
Ran 41 tests
FAILED (failures=5, errors=1)
```

The counterexamples proved the missing retry reservation, dropped requester accountability, and reversed adaptive rejection order. A follow-up participant-limit accountability counterexample also failed before its fix.

Focused and non-packaging verification:

```text
PYTHONPATH=src python3 -m unittest tests.test_models tests.test_backends tests.test_service tests.test_task_payload tests.test_cli -v
Ran 66 tests
OK

PYTHONPATH=src python3 -m unittest tests.test_models tests.test_primitives tests.test_backends tests.test_registry tests.test_service tests.test_codex_runtime tests.test_task_payload tests.test_cli tests.test_codex_live_e2e -v
Ran 109 tests
OK (skipped=1; opt-in live Codex E2E)
```
