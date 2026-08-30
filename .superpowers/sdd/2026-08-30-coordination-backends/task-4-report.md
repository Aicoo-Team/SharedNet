# Task 4 report: Codex JSONL runtime adapter

## Delivered

Implemented the bounded native Codex runtime in the Task 4-owned files:

- `src/sharednet/runtime/__init__.py`
- `src/sharednet/runtime/codex.py`
- `tests/test_codex_runtime.py`

`CodexRuntime` resolves binaries in constructor, `SHAREDNET_CODEX_BINARY`,
ChatGPT bundle, then `PATH` order. It runs `--version` only through the
explicit `availability()` check. Execution uses an injectable runner and a
default `Popen` runner with a timeout, `terminate()`, ten-second grace, and
`kill()` escalation.

The command uses the required global safety prefix before `exec` and includes
read-only sandboxing, no approvals, ephemeral execution, ignored user config,
JSONL, no color, and `multi_agent`. The prompt makes the first participant the
root (participant zero), requires exactly `N - 1` parallel native
`spawn_agent` calls, waits for all children, prohibits file/shell/web tools,
and requires the final JSON object with `synthesis` and structured outputs.

The parser retains the root thread ID, numeric usage, final agent message, raw
JSON-event count, collaboration records, distinct child thread IDs, and the
last 4,000 stderr characters. It deliberately ignores non-JSON diagnostics and
does not treat transient JSON `error` events as terminal when the process exits
zero with a valid final response. Final output and per-participant nonce markers
are validated fail-closed; marker text alone never proves native spawning.

`artifact_dir` saves raw stdout JSONL and stderr records using a sanitized
trace-ID filename, and returns their paths in runtime evidence.

## TDD evidence

### Initial RED

Command:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_codex_runtime -v
```

Observed before the runtime package existed:

```text
ModuleNotFoundError: No module named 'sharednet.runtime'
FAILED (errors=1)
```

### Native collaboration shape RED

After a successful native four-agent probe supplied the real
`item.completed`/`collab_tool_call` event shape, I first added a receiver-ID
regression test. Before parser support was added, the focused test produced:

```text
FAIL: test_parser_collects_real_collab_tool_call_receivers
AssertionError: Tuples differ: () != ('child-1', 'child-2', 'child-3')
```

### Marker binding RED

A test that swaps two otherwise valid markers initially produced:

```text
FAIL: test_marker_must_belong_to_its_named_participant
TerminalStatus.ACCEPTED != TerminalStatus.FAILED
```

The implementation now checks the marker is assigned to its named participant,
not merely that the set of markers is present.

### GREEN

Focused command:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_codex_runtime -v
```

Observed: `Ran 10 tests ... OK`.

Task 1–4 regression command:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_models tests.test_primitives tests.test_registry tests.test_backends tests.test_service tests.test_codex_runtime -v
```

Observed: `Ran 63 tests ... OK`.

Additional validation:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m compileall -q src tests
git diff --check
```

Both completed successfully with no output.

## Self-review

- Confirmed the installed ChatGPT bundle path is recognized and that CLI help
  accepts the selected safety and exec flags.
- Parsed the supplied successful native JSONL probe directly: one root thread,
  three distinct non-root receiver IDs, three completed native spawns, ten
  collaboration records, and all five reported token counters were retained.
- Confirmed that reconnect/error records do not independently cause failure.
- Confirmed malformed final content, missing markers, swapped markers, absent
  native spawn evidence, nonzero exits, and timeouts return typed failures.
- Confirmed artifact filenames cannot traverse outside `artifact_dir` through a
  crafted trace ID.

## Commit

Implementation commit: `1b3eb7e997382c72d1ec63442e0e8fc3b62e26d1`
(`feat: add codex JSONL runtime adapter`).

## Concerns

No live runtime execution is performed by these unit tests; the supplied
successful native probe was parsed as a fixture-level compatibility check. Live
E2E/CLI wiring remains outside Task 4 scope.

## Fix round 1: fail-closed runtime evidence and bounded artifacts

Committed implementation as `11ca4b6cc4651642b38aebca2cf4af926ca7e9bd`
(`fix: harden codex runtime evidence`).

### Delivered

- Native child IDs now come only from completed native `collab_tool_call`
  `spawn_agent` events or narrowly compatible collaboration spawn events with
  an `agent_thread_id`. Every sender must be the root; duplicate, missing, or
  surplus child IDs fail closed.
- The adapter requires a root `thread.started`, completed final agent message,
  and `turn.completed` before accepting a response. JSON reconnect/error events
  remain non-terminal.
- `model` is validated, defaults to `gpt-5.3-codex`, emits `-m`, and execution
  adds `--skip-git-repo-check` without altering the safety prefix.
- The timeout path preserves only the resumed authoritative `communicate()`
  output after termination or kill escalation.
- Every exact participant marker is now required in synthesis and in its bound
  participant output.
- Captures are bounded by a validated `max_capture_bytes` (default 1,000,000)
  before JSON parsing. Artifacts use random names plus exclusive, no-follow file
  creation and are never overwritten.
- Lookup now follows exactly explicit binary, environment binary, documented
  ChatGPT bundle, then `PATH`.

### RED evidence

Focused tests were added before each change. Representative observed failures:

```text
test_unrelated_agent_thread_ids_do_not_prove_or_pad_native_spawns
TerminalStatus.ACCEPTED != TerminalStatus.FAILED

test_command_uses_validated_model_and_skips_git_check
TypeError: CodexRuntime.__init__() got an unexpected keyword argument 'model'

test_acceptance_requires_completed_root_lifecycle
TerminalStatus.ACCEPTED != TerminalStatus.FAILED

test_default_runner_uses_authoritative_output_after_terminate
'prefixauthoritative-out' != 'authoritative-out'

test_synthesis_must_repeat_every_participant_marker
TerminalStatus.ACCEPTED != TerminalStatus.FAILED

test_oversized_capture_fails_before_json_parsing
TypeError: CodexRuntime.__init__() got an unexpected keyword argument 'max_capture_bytes'
```

### GREEN evidence

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_codex_runtime -v
```

Observed: `Ran 22 tests ... OK`.

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_models tests.test_primitives tests.test_registry tests.test_backends tests.test_service tests.test_codex_runtime -v
PYTHONDONTWRITEBYTECODE=1 python3 -m compileall -q src tests
git diff --check
```

Observed: `Ran 75 tests ... OK`; compile and diff checks exited successfully.

### Self-review and residual concern

Reviewed the strict source and sender gates for spawn proof, lifecycle flags,
stderr tail handling, timeout escalation, random exclusive artifact writes, and
binary ordering. The `Popen.communicate(timeout=...)` seam is intentionally
retained as required. Consequently, a child process can still allocate its full
stdout/stderr in memory before the post-return capture-size check rejects it;
this residual pre-return memory risk is documented rather than hidden.

## Fix round 2: root-authored spawn proof

Implementation commit: `f864a701bda17111ce2f5d3358b2c7710e21f2f8`
(`fix: require root-authored spawn evidence`).

Two regressions were written and observed RED before the narrow parser gate was
changed:

```text
test_one_participant_plan_rejects_any_spawn_evidence
TerminalStatus.ACCEPTED != TerminalStatus.FAILED

test_senderless_spawn_event_cannot_prove_root_authorship
TerminalStatus.ACCEPTED != TerminalStatus.FAILED
```

Spawn evidence now requires an explicit `sender_thread_id` that equals the root
thread ID. The legacy synthetic spawn fixture now records that root sender;
actual completed `collab_tool_call` events already carry it. Acceptance checks
the distinct child-ID count and raw spawn occurrence count against exactly
`N - 1`, including zero, so a one-participant plan rejects any child spawn.

GREEN verification:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_codex_runtime -v
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_models tests.test_primitives tests.test_registry tests.test_backends tests.test_service tests.test_codex_runtime -v
PYTHONDONTWRITEBYTECODE=1 python3 -m compileall -q src tests
git diff --check
```

Observed: Task 4 `24 tests ... OK`; Tasks 1–4 `77 tests ... OK`; compile and
diff checks passed. Self-review confirmed the zero-child and senderless gates
do not alter the prior strict duplicate/surplus, lifecycle, timeout, artifact,
or binary-order protections.
