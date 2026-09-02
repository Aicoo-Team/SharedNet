# Task 5 implementation report

## Scope

Implemented the local `sharednet coord` CLI, deterministic four-agent incident request, packaging entry point, user documentation, third-party notices, and repository ignore rules. Changes are limited to the Task 5-owned files.

## TDD evidence

- RED: `PYTHONPATH=src python3 -m unittest tests.test_cli -v` failed with `No module named sharednet.cli` / `ImportError`, before the CLI module existed.
- GREEN: after implementing the minimal CLI and example, the same test suite exposed an output-stream binding bug. After the targeted `_emit` fix, `PYTHONPATH=src python3 -m unittest tests.test_cli -v` passed all 5 tests.
- Coverage added: canonical list and alias JSON, pure four-participant planning with runtime construction prohibited, terminal runtime failure exit 1 with requested model, malformed request exit 2 with one structured JSON error, and unknown mechanism exit 2 with one structured JSON error.

## Verification evidence

- `PYTHONPATH=src python3 -m unittest discover -s tests -v`: 82 tests passed; no provider calls were made.
- `PYTHONPATH=src python3 -m sharednet.cli coord plan --mechanism rac-rge --request examples/four-agent-task.json`: produced an accepted `rac-rge` plan with `self`, `research-agent`, `architecture-agent`, and `risk-agent`.
- `python3 -m compileall -q src tests`: exited 0.
- System-wide `python3 -m pip install --no-deps -e .` was rejected by the host's externally managed Python policy (PEP 668). The equivalent isolated check succeeded: a temporary virtual environment installed the package editable and its installed `sharednet coord list` command emitted the four canonical mechanisms and `rac-adpt` alias.
- `git diff --check`: exited 0.

## Self-review

- `plan` reads through `CoordinationRequest.from_dict`, replaces only the immutable request mechanism, and never constructs `CodexRuntime`.
- `run` constructs `CodexRuntime(model=args.model)`, emits the typed result JSON, and maps accepted to exit 0 and every other terminal result to exit 1.
- Parser, file, JSON, request-contract, and unknown-mechanism errors are caught at the CLI boundary and emitted as one JSON error object on stderr with exit 2.
- The example fixes candidate order and scores so `rac-rge` deterministically selects four complementary admitted participants within the required depth, participant, retry, and wall-time bounds.
- Attribution names both immutable upstream commits, exact repository URLs, source paths/concepts, both copyright notices, and the full MIT text. No upstream repository internals are vendored.
