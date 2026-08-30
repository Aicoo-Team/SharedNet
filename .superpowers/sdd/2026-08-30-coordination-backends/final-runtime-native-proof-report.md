# Final Codex runtime native-proof hardening report

## Scope

Changed only `src/sharednet/runtime/codex.py`, `tests/test_codex_runtime.py`, and `tests/test_codex_live_e2e.py`. Planner/model/service and packaging changes were concurrent and were neither staged nor reverted. Per the task boundary, this slice did not invoke the real provider.

## Root cause

The previous adapter accepted recursively discovered identifiers and heuristic event names containing `collaboration`/`spawn`; it counted completed spawns but did not require completed waits or bind a spawned receiver to the participant marker in its prompt and child result. It also retained raw collaboration prompts/messages, ignored file/shell/web/MCP evidence, inherited the caller working directory, and delegated UTF-8 decoding to `subprocess` text mode.

## TDD evidence

Primary RED, after adding realistic completed `collab_tool_call` spawn/wait fixtures and fail-open regressions:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_codex_runtime -v
Ran 45 tests in 0.020s
FAILED (failures=19)
```

The failures were the intended vulnerabilities: compatibility event names, no/partial/failed/senderless/unplanned waits, wrong child marker, wrong spawn-prompt binding, disallowed command/file/shell/web/MCP evidence, unplanned collaboration actions, raw retained collaboration payloads, and missing completed-child evidence all remained fail-open.

Runner RED:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest -v \
  tests.test_codex_runtime.CodexRuntimeTests.test_default_runner_uses_an_empty_ephemeral_working_directory_and_inherited_auth \
  tests.test_codex_runtime.CodexRuntimeTests.test_invalid_utf8_from_default_process_returns_typed_failure
Ran 2 tests in 0.002s
FAILED (failures=1, errors=1)
```

The old runner passed no `cwd` and let invalid bytes escape into runtime handling as an untyped `AttributeError`; the regression was then made to report that escape as a test failure before production edits.

Bounded-evidence REDs:

```text
Ran 1 test in 0.004s
FAILED (failures=1: retained 300 disallowed diagnostics, expected <= 128)

Ran 1 test in 0.001s
FAILED (failures=1: disallowed-tool presence was lost after a full diagnostic buffer)
```

Fresh focused GREEN:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest tests.test_codex_runtime -v
Ran 49 tests in 0.018s
OK
```

## Implemented proof contract

- Only exact `thread.started`, `turn.completed`, `item.started`, and `item.completed` shapes are interpreted. Only completed, root-authored `collab_tool_call` values for `spawn_agent` and `wait` contribute proof; started/in-progress records must reach matching completion and never count on their own.
- Exactly one provider child receiver is bound to exactly one planned non-root marker from each successful spawn prompt. Duplicate/unplanned/missing bindings fail closed.
- Completed root-authored wait-state unions must equal the spawned child set. Every state must be `completed` with a nonempty message containing the marker bound to that exact child. The final root response never substitutes for child evidence.
- Runtime evidence exposes `spawned_agent_ids`, `completed_child_ids`, `contributing_child_ids`, `child_participant_bindings`, and `native_proof_complete` without exposing spawn prompts or child messages.
- Command, file, shell, web, MCP, file-change, and non-planned collaboration evidence fails closed. Diagnostic records contain bounded type/status/count facts only, are capped at 128 total, and retain a separate presence bit so truncation cannot reopen acceptance.
- A one-participant plan accepts only without spawn/wait evidence. The peer-forum bridge executes participant zero—the designated SELF integrator—as root and treats following peers as native children.
- Production `Popen` runs inside a fresh empty `TemporaryDirectory`, inherits the environment needed for local Codex authentication/configuration, and decodes stdout/stderr as UTF-8 with replacement.

## Real-transcript compatibility replay

The prior successful provider artifact was replayed through the new adapter with its recorded nonce and the current four-participant plan. Result: `accepted`; all three spawned UUIDs were exactly covered by completed waits and contributing messages; bindings resolved to `risk-agent`, `architecture-agent`, and `research-agent`; `native_proof_complete=true`; and `disallowed_tool_events=[]`.

## Broader verification

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest discover -s tests -v
Ran 152 tests in 0.408s
FAILED (errors=1, skipped=1)
```

All 150 executed non-packaging tests passed; the live provider test was intentionally skipped. The sole unrelated packaging error was reproduced independently as `ModuleNotFoundError: No module named 'setuptools'` from the selected Homebrew Python while packaging-owned files were under concurrent review. `compileall` over the owned runtime/tests and `git diff --check` both exited successfully with no output.

After the packaging owner committed its prerequisite handling, the fresh complete offline suite was green:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest discover -s tests -q
Ran 152 tests in 0.155s
OK (skipped=2)
```

The two explicit skips were the opt-in real-provider E2E and the unavailable local packaging prerequisite.
