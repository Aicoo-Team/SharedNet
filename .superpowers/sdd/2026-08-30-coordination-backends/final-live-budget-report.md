# Final live fixture budget report

## Scope

Raised only `examples/four-agent-task.json` from a 300-second to a 600-second hard wall and documented why. The production `CoordinationBudget` default remains 300 seconds. No planner, service, runtime, or algorithm semantics changed.

The fixture-specific allowance addresses observed provider variability: the latest live proof reached the prior 300-second boundary after two of three children completed amid transient DNS/WebSocket failures, while an earlier successful four-agent run required 291 seconds.

## Verification

Command:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m sharednet.cli coord plan --mechanism rac-rge --request examples/four-agent-task.json
```

Observed from the emitted plan:

- `budget.max_wall_seconds = 600`
- participants: `self`, `research-agent`, `architecture-agent`, `risk-agent`
- modes: `self`, `recruit`, `recruit`, `recruit`
- total predicted cost: `0.35`
- stop reason: `coverage_complete`

Default-contract check:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -c 'from sharednet.coordination.models import CoordinationBudget; print(CoordinationBudget().max_wall_seconds)'
```

Observed: `300`.

Formatting check:

```text
git diff --check
```

Observed: exit 0 with no output.
