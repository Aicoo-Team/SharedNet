# Tasks, Messages, and Recovery

> **Status:** Working specification
>
> **Normative for:** durable Task lifecycle, messages, delegations, attempts, leases, idempotency, failure and recovery
>
> **Parent:** [`../../PRD.md`](../../PRD.md)

## 1. Purpose

SharedNet turns transient model and runtime activity into one durable, user-visible Task. Acknowledged work must survive coordinator, runtime, bridge, and host restarts without losing ownership, intent, evidence, or attempt lineage.

SharedNet is the system of record for Task and network lifecycle. RAC returns a bounded coordination ledger; SharedOS returns authorization and execution events; bridges and providers report transport and runtime state. None becomes a competing durable Task state machine.

## 2. Durable objects

| Object | Responsibility |
| --- | --- |
| `Task` | User-visible goal, owner, Graph Intent, bounds, acceptance criteria, lifecycle, and final disposition |
| `TaskAttempt` | One recoverable execution attempt with lease, retry lineage, and terminal reason |
| `CoordinationRun` | One RAC invocation, Candidate Snapshot, organization graph, decisions, and terminal ledger |
| `Participant` | One task-time role backed by a persistent Agent or SpawnTemplate |
| `Delegation` | One task-scoped contract-bound edge between participants |
| `Message` | One durable information envelope with correlation and delivery state |
| `Artifact` | Output or evidence with provenance, base revision, disclosure, and retention metadata |
| `Checkpoint` | Recoverable Task/Environment state and lineage boundary |
| `TraceEvent` | Ordered reference to product, RAC, SharedOS, bridge, provider, and runtime activity |

A Message may exist without becoming a Task. A Task may contain many messages, attempts, coordination runs, delegations, artifacts, and checkpoints.

## 3. Task creation

Task creation records:

- immutable Task ID and owner Principal;
- requesting Agent and origin;
- natural-language request plus normalized TaskSpec;
- Graph Intent and exact identity references;
- Candidate search scope;
- disclosure and capability ceilings;
- deadline, cost, turn, depth, retry, and side-effect budgets;
- acceptance criteria and required evidence;
- idempotency key and request hash.

A Task is not acknowledged until its durable record and corresponding event/outbox entry are committed atomically.

## 4. Task lifecycle

```text
Requested
   ├── Rejected
   └── Accepted
         ├── Queued
         └── Running
               ├── Waiting for candidate
               ├── Waiting for recipient approval
               ├── Waiting for reply
               ├── Waiting for user approval
               ├── Paused
               ├── Failed
               ├── Cancelled
               ├── Expired
               └── Completed
                     ├── Verification failed
                     └── Verified
```

A RAC terminal status does not directly overwrite the Task state. SharedNet validates each transition and may create another attempt, wait for an external event, or finish the Task.

Every terminal outcome records a machine-readable reason and user-readable explanation.

## 5. Attempts and coordination runs

A Task may have multiple attempts because of:

- runtime or host failure;
- expired leases;
- changed candidate availability;
- failed or inconclusive verification;
- user-approved retry;
- route failover;
- structured local-to-Cloud handoff.

Each attempt receives a new Candidate Snapshot and CoordinationRun while preserving earlier evidence. Retry never rewrites failed history.

If work resumes from a checkpoint, the new attempt records:

- source attempt and checkpoint;
- Environment snapshot or workspace base;
- reused artifacts and evidence;
- session mode: resumed, forked, or fresh;
- any changed route, model, grants, or candidate set.

## 6. Durable messages

A Message is an information envelope, not authority. It contains:

- sender and recipient identities;
- Task and Delegation correlation when applicable;
- untrusted content and artifact references;
- disclosure labels and origin;
- idempotency key;
- created, accepted, delivered, acknowledged, replied, expired, or failed state;
- transport and runtime correlation references.

Receiving a Message cannot mint a Connection, widen a Delegation, grant a capability, or change the recipient's ownership.

### 6.1 Delivery semantics

- Submission is at-least-once with durable idempotency.
- Duplicate request hashes return the existing object.
- Reusing one idempotency key with a different request hash is rejected.
- Delivery may retry; recipient processing and protected side effects require their own idempotency.
- A transport spool may aid last-mile recovery but is not the authoritative Message store.
- Cross-Principal delivery revalidates relationship, Delegation, and grant state immediately before injection.

## 7. Delegation lifecycle

The complete contract schema is defined in [Discovery, Connections, and Delegation](02-discovery-connections-delegation.md). Its lifecycle is:

```text
Proposed
  ├── Rejected
  ├── Expired
  └── Accepted or Narrowed
        ├── Queued
        ├── Running
        ├── Cancelled or Revoked
        ├── Failed
        └── Completed
```

A narrowed contract becomes the new effective ceiling and must be accepted by the requester if it materially changes the required deliverable.

Onward delegation creates a distinct child Delegation and must inherit the original Task origin and attenuated ceilings.

## 8. Leases and concurrency

SharedNet uses expiring leases for:

- Task attempts and coordination workers;
- runtime endpoint ownership;
- Session turn injection;
- mutable Task workspace integration;
- provider wake-up or execution claims.

Lease expiry makes work recoverable. It does not silently mark the attempt successful or failed.

A Session has one writer lease for inbound turns. A canonical workspace has one integrator/writer lease. Parallel analysis and isolated workspaces may proceed without sharing those leases.

## 9. Checkpoints

Long-running or failure-prone work creates durable checkpoints at meaningful boundaries, including:

- accepted TaskSpec and Graph Intent;
- sealed Candidate Snapshot;
- completed required delegation;
- verified intermediate artifact;
- workspace integration base;
- pre-side-effect approval boundary;
- local-to-Cloud handoff.

A checkpoint is useful only if SharedNet can state what can be resumed, what must be recomputed, and which authority must be revalidated.

## 10. Required failure behavior

| Failure | Required behavior |
| --- | --- |
| No candidate passes admission | Explain the missing relationship, exposure, authority, context, availability, or budget; abstain or ask the user |
| Required external Agent is offline | Keep the Delegation durable, show waiting and expiry, allow cancellation or policy-permitted fallback |
| Recipient approval is pending | Park the same idempotent Delegation and resume after the decision |
| Session dies before delivery | Resume, fork, or fail according to adapter capability; never silently target another Session |
| Session dies during a turn | End the attempt with attributable partial evidence; retry only within policy |
| SharedNet restarts | Reclaim expired leases and resume from durable state |
| Duplicate submission or delivery | Return the existing object or suppress duplicate processing |
| Connection or grant is revoked | Deny the next protected action or injection and pause/fail according to Task policy |
| RAC exhausts a budget | Persist its terminal ledger and explicit exhausted reason |
| Verification is inconclusive | Do not label verified; retry, recruit review, escalate, or fail |
| Audit persistence fails around a side effect | Fail closed or use an atomic outbox; never report an unaudited successful mutation |
| Cloud handoff cannot restore state | Preserve the source Task and offer a labeled structured fork rather than claiming continuation |

## 11. Cancellation and revocation

Cancellation stops future Task work and attempts best-effort interruption of active runtime activity. It does not erase completed side effects or audit.

Revocation is evaluated at protected action boundaries. A revoked Connection, Delegation, route, secret reference, or grant must block subsequent use even if an earlier admission or Candidate Snapshot was valid.

## 12. Required invariants

1. Acknowledged Tasks and Messages survive process restarts.
2. Durable Task lifecycle has exactly one product owner: SharedNet.
3. Every retry and route change creates attributable attempt lineage.
4. Messages never carry authority.
5. Protected side effects are idempotent or explicitly approved.
6. Lease expiry enables recovery but never fabricates a result.
7. Verification state is explicit and cannot be inferred from completion alone.
8. Audit and state transition persistence are atomic around protected mutations.
