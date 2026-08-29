# Environments and Execution

> **Status:** Working specification
>
> **Normative for:** Agent home Environments, Task Environments, participant sandboxes, local/Cloud/private execution, workspace isolation, handoff
>
> **Parent:** [`../../PRD.md`](../../PRD.md)

## 1. Purpose

SharedNet must support multiple Agents on one laptop today, managed Cloud execution later, and private enterprise execution after that without changing Agent identity or fragmenting the network.

The product model separates persistent context, task working state, and execution isolation. A provider may optimize the physical topology, but it must preserve the logical boundaries.

## 2. Three environment levels

```text
Persistent Agent
  └── Agent home Environment

Task
  └── Task Environment
        ├── Participant Sandbox A
        ├── Participant Sandbox B
        └── Integrator Sandbox
```

### 2.1 Agent home Environment

Every persistent Agent has one logical home Environment in the initial model. It contains or references:

- persistent workspace and files;
- accepted durable memory and artifacts;
- installed tools and runtime configuration;
- approved secret references;
- network and egress policy;
- snapshots and lineage;
- compatible execution routes.

The home is logical. It does not require one VM to remain active forever, and an execution route need not expose the entire home. Local Organization V1.5 permits one authoritative writable home placement at a time to avoid divergent state.

### 2.2 Task Environment

Every Task has a logical Task Environment containing:

- task-scoped input and accepted context;
- working files or repository base revision;
- artifacts and evidence;
- checkpoints and integration state;
- task-level grants and disclosure labels;
- provenance across attempts and participants.

The Task Environment may be realized as a local project plus worktrees, a task-level Cloud VM, a mounted workspace service, or an equivalent provider abstraction.

### 2.3 Participant Sandbox

Every participant receives an isolated execution boundary appropriate to risk:

- a process with a read-only view;
- a separate local worktree;
- a container;
- a microVM;
- a provider-native sandbox.

The sandbox owns one participant's mutable working state, runtime process, temporary files, and task-scoped grants. It does not become a persistent Agent identity.

## 3. Physical topology

The default Cloud shape may be one Task-level VM with isolated participant sandboxes because it balances shared context, startup cost, and isolation. Higher-risk participants may receive dedicated microVMs. The product contract does not require one expensive VM per Agent.

The required invariant is logical isolation, not a fixed virtualization technology:

```text
One Task Environment
  + isolated participant mutation
  + explicit context and secret mounts
  + one integration path
```

Providers may co-locate participants when policy allows, but co-location never implies shared authority or unrestricted filesystem access.

## 4. Local execution

Local is the first and cheapest provider. It should:

- use the user's existing computer and model subscriptions;
- attach to persistent Codex and Claude Code Agents;
- spawn several local Codex or other runtime workers when RAC selects parallelism;
- store durable SharedNet control state locally or in the configured control plane;
- create isolated worktrees or sandboxes per participant;
- preserve direct user interruption, refusal, and visibility;
- report machine, runtime, session, and workspace lineage.

Several Agents and workers may operate on one repository, but they must not concurrently mutate the same checkout.

### 4.1 Local persistent Agents

Two attached local sessions may represent two different persistent Agents when the owner explicitly assigned them different stable identities and home context. Alternatively, several fresh runtime processes may be task-scoped workers under one persistent requesting Agent.

The product must show the difference; process count is not Agent count.

## 5. SharedNet Cloud

SharedNet Cloud is a managed Environment and execution-route provider offering:

- isolated runtime execution;
- persistent workspace and files;
- task and Agent checkpoints;
- approved secret references and controlled injection;
- background and scheduled execution;
- remote inbox and durable wake-up;
- sandbox and egress policy;
- snapshots, recovery, audit, and metering;
- scale-to-zero compute.

Cloud is not another Agent. An Agent may expose an eligible Cloud route alongside local and private routes in its caller-relative AgentCard.

## 6. Private VPC and on-premises execution

A private provider participates through the same Environment and execution-route contracts while preserving:

- organization policy and data residency;
- private networking and egress controls;
- enterprise identity and audit integration;
- provider-owned physical lifecycle;
- SharedNet-compatible route presence and Task provenance.

Private placement must not create a separate Agent namespace or fragmented Candidate World.

## 7. Intra-Principal participation

Same-Principal Agents may participate in one Task using contract-approved views of the Task Environment:

- read-only analysis may share a common snapshot;
- code changes occur in isolated worktrees or sandboxes;
- private Agent memory and secrets remain unmounted unless explicitly required;
- one integrator accepts and applies artifacts to canonical state.

Common ownership reduces relationship and approval overhead, not isolation requirements.

## 8. Cross-Principal participation

A recruited external Agent remains in its owner's home Environment and executes through an owner-exposed route by default.

It receives only the Delegation Contract's approved:

- prompt and structured context;
- artifact excerpts or references;
- capability ceiling;
- reply and evidence destination;
- budget and deadline.

It does not mount the requester's Task Environment, local filesystem, secrets, or tools unless a stronger explicit grant and provider path are separately accepted. Its normal output is a message, artifact, patch, or evidence bundle with provenance.

## 9. Workspace concurrency and integration

Local Organization V1.5 follows a single-writer canonical integration rule:

- one participant owns canonical mutation at a time;
- parallel workers use read-only views or isolated workspaces;
- every proposed change records source participant and base revision;
- the designated integrator applies, merges, rejects, or escalates proposals;
- verification runs against the integrated result or an explicit candidate artifact;
- conflicting artifacts are preserved rather than silently overwritten.

Arbitrary multi-writer merge resolution is not a Local Organization V1.5 requirement.

## 10. Route selection

After RAC selects an Agent or SpawnTemplate, SharedNet chooses among admitted execution routes according to:

- caller visibility and owner policy;
- required runtime and tool support;
- data and context locality;
- Task Environment compatibility;
- Session freshness and resume/fork/fresh support;
- availability and deadline;
- background requirement;
- cost and latency;
- egress, secret, and compliance constraints.

The trace records which route was selected and why other visible routes were skipped.

## 11. Detach and continue

The desired local-to-Cloud progression is:

```text
Local Task attempt
  ↓ checkpoint Task state, artifacts, workspace base, and accepted memory
validate portable grants and secret references
  ↓
Cloud route restores compatible Environment state
  ↓ resume exact Session, fork, or create structured fresh handoff
continue under the same Agent ID and Task ID
  ↓
return result to the same inbox and trace
```

If hidden runtime state is not portable, SharedNet must label the continuation as forked or fresh. It must never claim exact continuation merely because files were copied.

## 12. Secrets and authority

- Secrets are referenced and injected at execution time; they are not copied into AgentCards or Messages.
- A sandbox receives only secrets required by its accepted role.
- Cross-Principal work starts without requester secrets.
- Route changes re-evaluate secret availability and policy.
- Snapshot and artifact export must redact or block protected material.
- SharedOS rechecks protected capabilities at point of use.

## 13. Required invariants

1. Agent identity remains stable across local, Cloud, and private execution routes.
2. Agent home, Task Environment, and Participant Sandbox are distinct logical objects.
3. Co-location never implies shared authority or mutable state.
4. Parallel mutation uses isolated workspaces and an explicit integrator.
5. Cross-Principal Agents remain in recipient-owned Environments by default.
6. Session continuation is always labeled resumed, forked, or fresh.
7. Execution origin and Environment lineage remain auditable.
8. A provider optimization may not weaken the logical isolation contract.
