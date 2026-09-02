# Runtime deadline follow-up report

## Scope and commit

- Starting HEAD: `bca3e73` (`fix: reserve predicted cost across coordination retries`)
- Implementation and tests: `66e4f94e53bbd59b9e010bde146bb0fac62c3008`
  (`fix: include runtime setup in attempt deadline`)

Only `src/sharednet/runtime/codex.py` and `tests/test_codex_runtime.py`
changed in the implementation commit. Concurrent service, backend, model, and
packaging work was preserved and not staged.

## Delivered behavior

- `CodexRuntime.execute()` establishes one absolute monotonic deadline at
  entry. Binary resolution, nonce generation, prompt serialization, and
  command construction consume that same allowance.
- A custom runner receives only the strictly positive remaining relative
  seconds. The review counterexample now passes `6.0`, not `10.0`, after nonce
  setup consumes four seconds of a ten-second plan.
- Setup that reaches the deadline does not invoke the runner and returns
  `TerminalStatus.EXHAUSTED` with `error="codex_exec_timeout"` and explicit
  `timeout_phase="setup"` evidence.
- The production default runner receives the original absolute deadline in
  addition to the relative remainder. It cannot restart the deadline during
  the handoff, checks expiry before `Popen`, and continues to bound
  communicate, terminate grace, kill, and killed-process output collection by
  that same deadline.
- A default-runner timeout is represented as typed `EXHAUSTED` /
  `codex_exec_timeout`; captured JSONL usage and runtime evidence remain
  preserved.
- `availability()` continues to use an independent ten-second probe allowance
  and uses the injected monotonic clock on the production runner path.

There is no pre-launch artifact preparation in the current runtime. Artifact
creation is post-outcome evidence persistence, so no artifact setup operation
exists outside the pre-run deadline accounting above.

## TDD evidence

The initial review counterexample and setup-exhaustion tests ran RED together:

```text
$ PYTHONPATH=src python3 -m unittest -v \
  tests.test_codex_runtime.CodexRuntimeTests.test_setup_time_reduces_the_relative_allowance_passed_to_the_runner \
  tests.test_codex_runtime.CodexRuntimeTests.test_setup_exhaustion_returns_typed_timeout_without_launching_runner \
  tests.test_codex_runtime.CodexRuntimeTests.test_default_runner_uses_the_runtime_deadline_remainder
Ran 3 tests
FAILED (failures=3)

AssertionError: 10.0 != 6.0
AssertionError: ACCEPTED != EXHAUSTED
AssertionError: [10.0] != [6.0]
```

An absolute-deadline handoff regression then exposed the remaining extension:

```text
AssertionError: [6.0] != [5.0]
Ran 1 test; FAILED (failures=1)
```

Finally, a deadline spent exactly at the default-runner handoff proved the
process was not launched but the status was still incorrectly `FAILED`:

```text
AssertionError: FAILED != EXHAUSTED
Ran 1 test; FAILED (failures=1)
```

Each regression was made GREEN with the minimal production change before the
next boundary was added.

## Verification

Focused runtime/service verification:

```text
$ PYTHONPATH=src python3 -m unittest tests.test_codex_runtime tests.test_service
Ran 55 tests in 0.029s
OK
```

Fresh pre-commit offline verification excluding the independently failing
packaging subprocess:

```text
$ PYTHONPATH=src python3 -m unittest tests.test_models tests.test_primitives tests.test_backends tests.test_registry tests.test_service tests.test_codex_runtime tests.test_cli tests.test_task_payload
Ran 113 tests in 0.284s
OK

$ PYTHONPATH=src python3 -m compileall -q src/sharednet
[exit 0]

$ git diff --check -- src/sharednet/runtime/codex.py tests/test_codex_runtime.py
[exit 0]
```

No live provider test was run or modified.

## Residual concern

A broader 114-test offline invocation passed 113 tests and errored only in
`tests.test_packaging.PackagingTests.test_offline_wheel_contains_provenance_files_and_metadata`:
its independently owned `pip wheel --no-build-isolation --no-index` subprocess
exited 2. The failure did not touch or implicate the runtime-owned files; the
113-test non-packaging suite is green.
