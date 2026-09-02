# Task 6 report: live four-agent Codex proof

## Delivered

- Added `tests/test_codex_live_e2e.py`, an opt-in unittest gated by
  `RUN_CODEX_E2E=1`.
- The test loads the checked-in request through `CoordinationRequest.from_dict`,
  asserts the deterministic `rac-rge` participant sequence
  (`self`, `research-agent`, `architecture-agent`, `risk-agent`), and verifies
  the frozen task payload survives both planning and runtime execution.
- The live assertion requires acceptance, four outputs, a root thread ID,
  exactly three distinct native child thread IDs, positive input plus output
  token usage, every participant marker in the synthesis, and all four
  incident IDs.

## Live provider evidence

Authorized command:

```sh
RUN_CODEX_E2E=1 SHAREDNET_CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex PYTHONPATH=src python3 -m unittest tests.test_codex_live_e2e -v
```

Observed result: `OK`; one test completed in `291.007s`.

- Terminal status: `accepted`
- Root thread ID: `01a051b9-a92d-7a11-ab53-52bd5b2f7f44`
- Native child thread IDs:
  - `01a051bb-ab2c-77b3-b271-20f252c4cd05`
  - `01a051bb-aba5-7a02-b765-62ace693df99`
  - `01a051bb-abca-7412-9cd0-211c8a6b288f`
- Raw JSONL event count: `23`
- Usage: `input_tokens=183240`, `output_tokens=1841` (positive total)
- Retained raw artifact (gitignored):
  `.codex-live-artifacts/incident-remediation-brief-001-attempt-0-efaf7ca1b06f4a3f919cad56.stdout.jsonl`

The transcript shows three root-authored completed `spawn_agent` calls and a
completed turn with structured final output. The runtime accepted the result;
no parser or production change was necessary.

The initial local test invocation stopped before contacting the provider
because the test's expected deterministic participant order was reversed. The
literal was corrected to the planner's actual order above; the subsequent
provider invocation is the recorded successful run.

## Verification

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
python3 -m compileall -q src tests
git diff --check
```

Observed: the offline suite passed with exactly the one opt-in live provider
test skipped; compilation and whitespace checks passed.
