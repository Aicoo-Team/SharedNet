# Idea — Agent lifecycle, promotion, and accumulated experience

> **Status:** Exploratory; not a roadmap commitment
>
> **Question:** When should SharedNet use a fresh worker, resume a persistent Agent, or promote a useful task worker into a persistent Agent?

## 1. The distinction

SharedNet needs both fresh and accumulated intelligence:

- a fresh spawned worker offers independent context, cheap parallelism, and low long-term state cost;
- a persistent Agent offers specialized memory, relationships, ownership, verified experience, and a stable inbox;
- a renewable Session offers temporary continuity without becoming the durable identity or memory store.

Treating every call as a brand-new Agent loses useful accumulated context. Treating every worker as permanent creates clutter, stale state, policy burden, and misleading identity.

## 2. Default lifecycle

```text
SpawnTemplate
  ↓ task selects SPAWN
Ephemeral Participant
  ↓ completes role and returns evidence
Task history + ExperienceRecord
  ↓ repeated verified value and explicit owner decision
Promotion candidate
  ↓ identity, policy, home Environment, and exposure configured
Persistent Agent
```

Promotion is explicit. RAC may recommend it but cannot create a durable Agent identity or expose it to the network without Principal approval.

## 3. Promotion signals

A worker may be worth promoting when:

- the same role recurs across Tasks;
- it accumulates durable domain artifacts that materially improve later work;
- other Agents need a stable address and inbox for it;
- its verified performance is consistently useful;
- maintaining its Environment costs less than repeatedly reconstructing context;
- clear ownership, policy, and disclosure boundaries can be defined.

A worker should remain ephemeral when its value is task-specific, its context should be discarded, its independence is important, or its long-term state would create more risk than utility.

## 4. Accumulated state

A persistent Agent may accumulate:

- curated durable memory and artifacts;
- domain-specific tools and Environment configuration;
- Principal relationships inherited through owner policy;
- verified coordination experience;
- task preferences and refusal policy;
- multiple renewable Sessions and execution routes.

Raw transcripts are not the durable memory model. Important conclusions and artifacts are explicitly promoted with provenance, confidence, retention, and revocation semantics.

## 5. Agent evolution without identity cloning

An Agent can change:

- model or runtime;
- Session;
- local/Cloud/private route;
- tools and Environment snapshot;
- capability claims;
- exposure and recruitment posture.

These changes update its AgentCard and lineage; they do not create another Agent unless the owner intends a distinct accountable service identity.

## 6. Experience versus authority

Repeated successful collaboration may create an ExperienceRecord such as “`@liyi/api` is effective for API review with `@xisen/coding`.” It does not create a persistent Agent-to-Agent Connection or widen future authority.

Experience influences RAC ranking only after current discovery, relationship, admission, and grant checks pass.

## 7. Open questions

- What minimum verified history justifies a promotion recommendation?
- Which task artifacts may seed a new Agent home Environment?
- How does the owner review and redact accumulated state before promotion?
- When should an Agent be split into two more specific identities?
- How should stale experience decay after model, tool, or Environment changes?
- Can a Principal publish a reusable Agent template without publishing the Agent's private memory?
