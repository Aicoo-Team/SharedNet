# Runtime timeout precedence repair report

## Scope and commit

- Starting HEAD: `8248c68` (`fix: preserve requester accountability on cost replans`)
- Implementation and test commit:
  `b59df29344abde113d25433f131f819aad225a33`
  (`fix: prioritize runtime timeout over capture size`)

The implementation commit changes only `src/sharednet/runtime/codex.py` and
`tests/test_codex_runtime.py`. All newer cost, packaging, service, backend, and
documentation commits were preserved.

## Repaired behavior

- A `ProcessOutcome` that is both timed out and over the capture limit now
  returns typed `TerminalStatus.EXHAUSTED` with
  `error="codex_exec_timeout"`; capture size no longer masks deadline
  exhaustion as `FAILED/codex_output_too_large`.
- Oversized timed-out stdout is never passed to the JSONL parser. The
  regression uses a `str` subclass whose `splitlines()` raises, proving parsing
  is skipped.
- Oversized timed-out output is not persisted as an artifact. Runtime evidence
  retains only bounded facts: exit code, timeout flag, aggregate captured
  bytes, configured maximum, and separate stdout/stderr byte counts. It does
  not retain stdout, stderr, parsed events, or artifact paths.
- A non-timeout oversized capture follows the existing path unchanged:
  `TerminalStatus.FAILED` / `codex_output_too_large`, before parsing and before
  artifact persistence.
- Non-oversized timeout evidence, usage parsing, bounded artifacts, and the
  absolute runner deadline/termination behavior from the preceding repair are
  unchanged.

## TDD evidence

Focused RED against the review counterexample:

```text
$ PYTHONPATH=src python3 -m unittest -v \
  tests.test_codex_runtime.CodexRuntimeTests.test_timeout_dominates_oversize_without_parsing_or_persisting_payload
FAIL: test_timeout_dominates_oversize_without_parsing_or_persisting_payload
AssertionError: FAILED != EXHAUSTED
Ran 1 test; FAILED (failures=1)
```

The minimal precedence branch was then added before JSONL parsing and artifact
persistence. Focused GREEN:

```text
$ PYTHONPATH=src python3 -m unittest -v \
  tests.test_codex_runtime.CodexRuntimeTests.test_timeout_dominates_oversize_without_parsing_or_persisting_payload
Ran 1 test in 0.001s
OK
```

## Verification

```text
$ PYTHONPATH=src python3 -m unittest tests.test_codex_runtime tests.test_service
Ran 57 tests in 0.024s
OK

$ PYTHONPATH=src python3 -m unittest tests.test_models tests.test_primitives tests.test_backends tests.test_registry tests.test_service tests.test_codex_runtime tests.test_cli tests.test_task_payload
Ran 117 tests in 0.199s
OK

$ PYTHONPATH=src python3 -m compileall -q src/sharednet
[exit 0]

$ git diff --check -- src/sharednet/runtime/codex.py tests/test_codex_runtime.py
[exit 0]
```

No live provider test was run or modified. No residual runtime concern was
identified in this narrow precedence repair.
