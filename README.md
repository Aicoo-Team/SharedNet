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

From a source checkout, plan locally and offline (this does not construct or invoke a model runtime):

```console
sharednet coord list
sharednet coord plan --mechanism rac-rge --request examples/four-agent-task.json
```

An actual runtime invocation is opt-in:

```console
sharednet coord run --mechanism rac-rge --request examples/four-agent-task.json --model gpt-5.6-luna
```

`run` uses the locally available Codex runtime with a bounded, read-only plan. It returns the runtime evidence, participant markers, usage, and terminal state as JSON. An accepted result exits with `0`; other terminal runtime outcomes exit with `1`. Invalid request data, argument errors, and unknown mechanisms exit with `2` and write one structured JSON error to standard error.

Planning operates only on the request's admitted, immutable candidate snapshot. It respects participant, depth, retry, wall-time, and disclosure bounds; execution failures can exclude attributable participants for a bounded replan but cannot expand the candidate set or authority. A plan is an inspectable proposal rather than proof of model behavior: treat runtime evidence and acceptance criteria as the basis for evaluating the returned result.
