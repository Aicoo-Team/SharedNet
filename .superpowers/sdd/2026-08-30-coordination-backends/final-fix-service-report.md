# Final fix report: service attribution and request-wide budgets

## Scope and commits

- Review base: `176b45bf6ab1178ea68cdcfc8ce0498bff20cb9e`
- Concurrent cost-budget commit incorporated before this change:
  `0e1470f` (`fix: enforce coordination predicted cost budget`)
- Implementation and regression tests: `7bc7370`
  (`fix: enforce request-wide coordination budgets`)

The implementation commit changes only the assigned service, Codex runtime,
and their two test modules. Concurrent changes to models, backends, packaging,
and provenance files were preserved and were not staged by this work.

## Delivered behavior

- Retry attribution now intersects the immutable admitted candidate IDs with
  the participant IDs in the exact plan that failed. An admitted candidate
  omitted from that plan cannot trigger a retry, while the raw reported IDs,
  error, and runtime evidence remain intact.
- `CoordinationService` accepts an injected monotonic clock and establishes one
  request-wide wall deadline. Planning and execution receive only positive
  remaining wall allowances; deadline exhaustion stops recovery, and a result
  returned at or after the deadline is represented truthfully as
  `EXHAUSTED` / `wall_time_budget_exhausted` without discarding outputs,
  evidence, usage, or attempt summaries.
- Every planned participant execution reserves one SharedNet turn. Remaining
  turns cap the next attempt's effective participant count, attempt summaries
  and final numeric usage expose `planned_turns`, and an attributable retry is
  stopped as `EXHAUSTED` / `turn_budget_exhausted` when no turns remain.
- Standalone planning with `max_turns=1` emits at most one participant. The
  Codex prompt explicitly defines the per-participant turn reservation,
  forbids unplanned participants/turns, and tells a one-participant root not to
  spawn a child.
- The default process runner measures one monotonic attempt deadline. Its
  terminate grace and kill/output collection use only the remaining allowance;
  deterministic fake-clock/process tests cover both partial grace and an
  already-spent deadline. Direct successful Codex execution continues to pass
  the plan's default `300.0` second allowance to the runner.

## TDD evidence

Initial focused RED:

```text
$ PYTHONPATH=src python3 -m unittest tests.test_service tests.test_codex_runtime
Ran 46 tests
FAILED (failures=7, errors=5)
```

The failures showed the admitted-but-unselected retry, absent turn capping and
usage, missing service/runtime clock seams, late acceptance remaining accepted,
zero-child spawn wording, and fixed terminate grace beyond the attempt
allowance.

An additional preservation regression was run RED after the first GREEN:

```text
FAIL: test_deadline_expiring_during_replan_preserves_prior_failure_evidence
AssertionError: () != ('self',)
Ran 1 test; FAILED (failures=1)
```

The minimal follow-up retained the prior failed result when a replan itself
consumed the deadline. Final focused GREEN:

```text
$ PYTHONPATH=src python3 -m unittest tests.test_service tests.test_codex_runtime
Ran 47 tests in 0.067s
OK
```

## Verification

Fresh pre-commit verification:

```text
$ PYTHONPATH=src python3 -m unittest tests.test_models tests.test_primitives tests.test_backends tests.test_registry tests.test_service tests.test_codex_runtime tests.test_cli tests.test_task_payload
Ran 102 tests in 0.386s
OK

$ PYTHONPATH=src python3 -m compileall -q src/sharednet
[exit 0]

$ git diff --check -- src/sharednet/coordination/service.py src/sharednet/runtime/codex.py tests/test_service.py tests/test_codex_runtime.py
[exit 0]
```

No live provider test was run or changed.

## Residual concerns

- A broader 103-test non-live invocation passed 102 tests and errored only in
  the concurrently owned `tests.test_packaging` wheel-build subprocess. The
  focused service/runtime suite and the complete 102-test non-packaging suite
  are green; packaging remains for its owning worker to verify after its
  in-progress files settle.
- The service can classify an injected runtime that returns after its deadline,
  but it cannot preempt an arbitrary third-party runtime implementation. The
  shipped Codex runtime honors the plan allowance and bounds its own
  termination escalation.
- At a fully spent subprocess deadline, kill is issued and output collection is
  attempted with a zero-second timeout so the allowance is not extended. On an
  unusually slow OS reap, captured output may therefore be partial rather than
  blocking past the deadline.
