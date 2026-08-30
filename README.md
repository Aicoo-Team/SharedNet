# SharedNet

SharedNet is a programmable network through which independently running agents become addressable, authorized, and able to complete work together.

SharedNet composes:

- **SharedOS** for permission-controlled execution;
- **Runtime Agent Coordination (RAC)** for bounded task-time coordination;
- **SharedNet's durable control plane** for identity, connections, endpoints, tasks, recovery, and observability.

## Product documentation

- [SharedNet Product Requirements Document](docs/product/PRD.md)
- [Detailed specifications, decisions, and ideas](docs/product/PRD/README.md)

The first product milestone is **Local Organization**: one Principal gives a natural-language goal to exposed persistent local Codex/Claude Agents and bounded local workers; SharedNet forms the smallest useful authorized RAC organization, isolates participant workspaces, and returns one inspectable verified result. Connected Principals and SharedNet Cloud expand the same Candidate World in later milestones.

## Coordination backends

SharedNet includes four deterministic coordination planners: `discovery-and-use`, `rac-rge`, `rac-adaptive`, and `peer-forum`. They are default baselines for inspecting bounded coordination behavior, not claims of benchmark-winning performance. The compatibility spelling `rac-adpt` resolves to the canonical `rac-adaptive` mechanism; plans and results always record the canonical identity.

Install the source checkout first:

```console
python3 -m pip install -e .
```

Use `python3 -m pip install -e '.[test]'` when running the offline packaging verification; it requires setuptools 77 or newer in the current interpreter.

Then plan locally and offline (this does not construct or invoke a model runtime):

```console
sharednet coord list
sharednet coord plan --mechanism rac-rge --request examples/four-agent-task.json
```

An actual runtime invocation is opt-in:

```console
sharednet coord run --mechanism rac-rge --request examples/four-agent-task.json --model gpt-5.6-luna
```

The checked-in four-agent live fixture uses a bounded 600-second hard wall to accommodate root-plus-three provider and transport variability. The product `CoordinationBudget` default remains 300 seconds.

`run` uses the locally available Codex runtime with a bounded, read-only plan. It returns the runtime evidence, participant markers, usage, and terminal state as JSON. An accepted result exits with `0`; other terminal runtime outcomes exit with `1`. Invalid request data, argument errors, and unknown mechanisms exit with `2` and write one structured JSON error to standard error.

Planning operates only on the request's admitted, immutable candidate snapshot. Request-wide wall-time, turn, and predicted-cost ceilings are consumed across attempts; dependency depth, participant count, and retry count are also hard bounds. `max_disclosure_bytes` limits the serialized task payload accepted at the request boundary, not the entire generated Codex prompt, process output, or evidence record. Execution failures can exclude attributable participants for a bounded replan but cannot expand the candidate set or authority.

`CandidateMode` describes pre-admitted organization authority: `SELF`, `RECRUIT`, or `SPAWN`. The local Codex adapter's root and native child threads are execution transport for the already approved participant plan; creating a native child does not change a participant's mode or grant spawn authority.

A plan is an inspectable proposal rather than proof of model behavior: treat runtime evidence and acceptance criteria as the basis for evaluating the returned result. The current process adapter uses `communicate()`, so stdout and stderr are buffered in memory before `max_capture_bytes` is checked; that check fails oversized evidence closed, but it is not a streaming memory bound.
