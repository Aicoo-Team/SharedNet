# Task 5A report: bounded task payload propagation

## Scope and hashes

- Base: `64603eb914947bd88aab8b4e4dcdfad0e2bd6782`
  (`feat: add coordination CLI and offline example`)
- Implementation: `5f997e1bdccbfdd785532334a793591993dd36ad`
  (`fix: preserve coordination task payload`)

The repair changes only the assigned model and shared backend boundaries, the
new Task 5A regression test, Task 5's checkout-isolated CLI test helper, and
the source-checkout clarification in the README. No Codex provider invocation
was made.

## Delivered

- `CoordinationRequest` now rejects a task whose canonical compact UTF-8 JSON
  payload (`ensure_ascii=False`, sorted keys, compact separators) exceeds
  `budget.max_disclosure_bytes`; an exactly sized payload remains valid.
- The shared `make_plan` constructor preserves each mechanism's coordination
  instructions and installs the authoritative frozen task payload under
  `runtime_instructions["task"]` last, so mechanism-specific data cannot
  replace it.
- The integration contract loads the checked-in four-agent incident request,
  plans through `CoordinationService`, and proves the serialized plan and
  Codex prompt contain the exact task payload, goal, all acceptance criteria,
  and `INC-101` through `INC-104`.
- Black-box CLI subprocesses prepend this checkout's absolute `src` directory
  to `PYTHONPATH`; README wording now states that the checked-in commands are
  run from a source checkout.

## TDD evidence

Initial payload-propagation RED:

```text
KeyError: 'task'
```

The planner emitted only mechanism instructions, so the integration test could
not retrieve the task payload.

Disclosure-boundary RED:

```text
AssertionError: ValueError not raised
```

An oversized compact UTF-8 task payload was accepted before validation was
added.

Collision-protection RED:

```text
'mechanism-supplied value' != {'task_id': 'authoritative-task', ...}
```

The shared constructor previously allowed a mechanism-supplied `task` value to
survive. The final focused GREEN command was:

```sh
PYTHONPATH=src python3 -m unittest tests.test_task_payload -v
```

Observed: `Ran 3 tests ... OK`.

## Verification

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
PYTHONPATH=src python3 -m sharednet.cli coord plan --mechanism rac-rge --request examples/four-agent-task.json
PYTHONDONTWRITEBYTECODE=1 python3 -m compileall -q src tests
git diff --check
```

Observed: the offline Task 1–5 suite ran 85 tests with `OK`; the CLI emitted
an accepted four-participant `rac-rge` plan whose `runtime_instructions.task`
contained the full incident payload; compile and diff checks exited 0.

## Self-review

- The plan contract remains immutable and JSON-safe: task payloads are frozen
  by `CoordinationPlan` and thawed only by its existing `to_dict()` boundary.
- Admission filtering still happens before ranking; the repair only augments
  construction of existing runtime instructions.
- The task was not duplicated as a `CoordinationPlan` top-level field.
- The byte cap measures the specified task payload, not prompt or protocol
  overhead, and applies before planning/runtime execution.
