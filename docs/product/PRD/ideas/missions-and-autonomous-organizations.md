# Idea — Missions and autonomous organizations

> **Status:** Exploratory; not a roadmap commitment
>
> **Question:** Can a user give SharedNet an outcome such as “start a company,” after which it forms and evolves a durable organization of Agents?

## 1. Why this might matter

Tasks are currently bounded around one deliverable and one acceptance lifecycle. Some goals are better described as long-lived outcomes:

- launch and operate a small product;
- run a research program;
- maintain customer support;
- monitor a market and act under approval;
- operate recurring sales or engineering functions.

For these, the organization may need to persist, recruit different specialists over time, create recurring Tasks, preserve institutional state, and change strategy after evidence.

## 2. Candidate object

A possible object above Task is **Mission**:

```text
Mission
├── outcome and measurable state
├── Principal owner and authority ceiling
├── budget, timeline, and approval constitution
├── evolving Candidate World policy
├── persistent roles and recruited Agents
├── Tasks, schedules, and checkpoints
├── decisions and accumulated evidence
└── stop, pause, review, and shutdown conditions
```

A Mission would not be one infinitely running RAC call. SharedNet would create a sequence of durable Tasks, each with its own Candidate Snapshot, organization, authority, evidence, and terminal state.

## 3. Example

User goal:

> 帮我开一个小公司，先找到可验证的市场机会；任何花钱、签约或公开发布都要我批准。

Possible emergence:

```text
Mission: validate and launch a company
  ↓
Task: market hypotheses
  → SELF + parallel researchers
  ↓ verified shortlist
Task: customer interviews
  → RECRUIT domain and outreach Agents
  ↓ evidence checkpoint
Task: prototype
  → coding Agent + spawned workers + independent verifier
  ↓ user approval
Task: launch
  → explicit side-effect grants only
```

The value is not “many Agents.” It is durable organizational adaptation around a measurable outcome.

## 4. Safety and product constraints

A Mission must have stronger bounds than a Task:

- explicit financial, legal, publication, and external-communication approval classes;
- recurring spend and cumulative budget ceilings;
- human review intervals;
- durable rationale and decision log;
- easy pause and shutdown;
- no authority laundering through recursive recruitment;
- no self-expansion of Principal relationships;
- clear ownership of accounts, data, credentials, and generated assets.

“Start a company” must never be interpreted as permission to incorporate, spend money, contact people, accept terms, or publish without explicit applicable grants.

## 5. Prerequisites

This idea should not enter committed scope before SharedNet proves:

1. durable Tasks and recovery;
2. reliable candidate admission and bounded RAC organization;
3. recipient-owned Cross-Principal Delegation;
4. scheduled/background execution;
5. cumulative budgets and approval policy;
6. strong artifact, evidence, and side-effect provenance;
7. meaningful quality gains over simpler single-Agent operation.

## 6. Open questions

- Is Mission a first-class object or an application built on Tasks and schedules?
- Which roles persist across Tasks, and which are selected anew?
- How does a Mission modify its plan without modifying its constitutional authority ceiling?
- What evidence closes, pivots, pauses, or fails a Mission?
- How should the UI summarize months of organizational history without becoming a workflow builder?
