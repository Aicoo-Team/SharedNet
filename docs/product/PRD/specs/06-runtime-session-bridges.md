# Runtime and Session Bridges

> **Status:** Working specification
>
> **Normative for:** Codex/Claude Code/custom runtime attachment, live-session reachability, delivery, correlation, resume/fork/fresh behavior
>
> **Parent:** [`../../PRD.md`](../../PRD.md)

## 1. Purpose

A Runtime and Session Bridge makes a real Agent execution route addressable without pretending that SharedNet owns the runtime's hidden session state.

The initial bridge targets are Codex and Claude Code. The existing Aicoo Local Agent / CC-Direct line of work is a key reference because it demonstrates delivery to stateful sessions while preserving recipient ownership and correlated replies.

## 2. Boundary

The bridge owns:

- runtime-specific attach and authentication handshake;
- live-session and endpoint registration;
- provider-native Session ID mapping;
- durable last-mile delivery spool;
- turn delivery and streamed correlated replies;
- interruption and cancellation when supported;
- runtime-specific resume, fork, fresh, and dead-session recovery;
- lease, health, and capability reporting.

The bridge does not own:

- Principal or Agent identity;
- Candidate World policy;
- RAC selection or organization;
- SharedNet Task and Message authority;
- Principal Connections or Delegation policy;
- SharedOS authorization semantics;
- cross-task experience.

Its spool is a transport recovery mechanism. SharedNet remains authoritative for Tasks, Messages, and delivery state.

## 3. Common contract

A runtime adapter should expose honest support for:

```text
register / unregister
discover health and capabilities
attach / detach
resume / fork / fresh
deliver / acknowledge
stream reply / return artifact
interrupt / cancel
renew / release lease
```

Unsupported operations return explicit capability errors. SharedNet must not simulate successful resume, fork, interruption, or delivery.

## 4. Cross-app local flow

When a Codex Agent asks a local Claude Code Agent for analysis:

```text
Codex requesting Session
  ↓ SharedNet Task + Delegation + durable Message
SharedNet policy and SharedOS grant compilation
  ↓ authorized delivery envelope
Session Bridge
  ↓ Claude Code adapter
recipient-owned live/resumed/forked/fresh Session
  ↓ correlated response
SharedNet Message and Task state
  ↓ wake/resume requester
Codex requesting Session
```

This is not direct terminal piping and never mutates another runtime's transcript files. The bridge uses supported interfaces and reports correlation, retries, cancellation, and runtime origin.

## 5. Session modes

| Mode | Meaning |
| --- | --- |
| `resumed` | The adapter can restore or continue the runtime's same supported Session identity |
| `forked` | Work begins from an explicit copy or handoff derived from an earlier Session/context |
| `fresh` | Work begins in a new Session with structured context and no claim of hidden-state continuity |

SharedNet records the mode and source lineage on every Task attempt. Files, summaries, or checkpoints alone do not prove exact Session resumption.

## 6. Delivery envelope

The bridge receives a bounded envelope containing:

- SharedNet Message ID and idempotency key;
- sender, recipient Agent, Task, and Delegation references;
- untrusted prompt/content;
- approved artifact references;
- SharedOS AccessContext or grant reference;
- deadline and cancellation token;
- expected reply and artifact destinations;
- origin and disclosure labels.

The bridge may translate this envelope into runtime-native input. It may not widen context or authority during translation.

## 7. Safety

- Every inbound message is untrusted content, never authority.
- A Session has one writer lease for injected turns.
- Duplicate delivery is suppressed using the SharedNet idempotency key.
- Cross-Principal delivery revalidates Connection, Delegation, and grant state immediately before injection.
- Cross-Principal execution defaults to text/artifact-only unless a stronger grant is accepted.
- The adapter must not read or mutate runtime transcript storage through unsupported means.
- A dead Session may be resumed, forked, or replaced only according to declared adapter semantics.
- Partial replies and runtime death produce attributable failure evidence.

## 8. Presence and endpoint leases

A bridge registers time-bounded presence for an Agent execution route. Presence includes:

- endpoint and route identifiers;
- runtime type and supported operations;
- Session availability and freshness;
- current lease and concurrency state;
- local/background/scale-to-zero behavior;
- health timestamp.

Expired presence removes the route from online admission. It does not delete the Agent or its historical Session mapping.

## 9. Compatibility spike requirements

Before treating CC-Direct/Aicoo code as the production bridge, verify:

- supported Codex and Claude Code attach APIs;
- durable correlation and retry behavior;
- exact resume/fork/fresh guarantees;
- interruption and cancellation behavior;
- multi-session concurrency and writer locking;
- recipient ownership and consent semantics;
- compatibility with SharedNet Message IDs and SharedOS AccessContext;
- failure behavior across process and host restarts.

## 10. Required invariants

1. Runtime-native Session IDs are mappings, never Agent identity.
2. The bridge reports only capabilities it can actually provide.
3. Delivery remains idempotent and correlated across retries.
4. One Session accepts at most one injected writer turn at a time.
5. External content cannot widen grants.
6. Resume/fork/fresh semantics remain explicit and auditable.
7. Bridge state never replaces SharedNet's durable Task and Message state.
