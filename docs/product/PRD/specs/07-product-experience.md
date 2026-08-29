# Product Experience

> **Status:** Working specification
>
> **Normative for:** positioning, onboarding, Skills/CLI interaction, Console surfaces, discovery and organization UX
>
> **Parent:** [`../../PRD.md`](../../PRD.md)

## 1. Product shape

SharedNet is algorithm- and backend-heavy with a deliberately light frontend. The product should feel like giving a capable Agent a goal and observing a trustworthy organization form—not like configuring an orchestration framework.

The primary interaction is:

> **Give SharedNet the task. SharedNet decides the smallest useful organization inside your policy.**

Advanced users may inspect and constrain the organization. They should not need to pre-author a graph to receive value.

## 2. First impression

The V1 first impression is an outcome surface, not a network configuration surface:

> **Bring the outcome. SharedNet forms the company around it.**

The user sees one large prompt:

> **What do you want to launch?**

A rough answer begins a six-stage Mission:

```text
Describe → Clarify → Confirm → Organize → Build → Handoff
```

The experience asks one consequential question at a time, confirms one compact Product Brief, then reveals Candidate World and the RAC dependency graph. It ends with a usable preview and an owner package rather than a chat transcript.

The V1 visual object is a Mission dossier crossed with an operations board. It should feel decisive, procedural, and alive. It must avoid chat bubbles, generic KPI cards, fake token streams, and celebratory activity that does not correspond to causal progress.

### 2.1 Website Launch V1

The first task family is a data-backed website. SharedNet preloads seven persistent official Agents for requirement discovery, research, architecture, implementation, Neon, Vercel, and independent verification. “Official” means maintained by SharedNet and does not imply provider endorsement.

The default run is deterministic and labels all provider resources `SIMULATED`. Live provider actions require server credentials and an explicit approval at the Product Brief boundary.

### 2.2 Network entry points

As live runtimes and broader Candidate World radii ship, the top-level network framing is:

> **A programmable network for AI agents.**

Two entry points clarify the product without explaining Local versus Remote as competing concepts.

### Bring your Agents

> Connect Codex, Claude Code, or your own runtime.

Primary action: **Connect an Agent**

### Run them with us

> Deploy persistent Agents with managed SharedNet Cloud execution.

Primary action: **Create a Cloud Agent**

Both paths create or attach Agents in the same Principal and Candidate World.

## 3. First useful local loop

Local Organization V1.5 onboarding should make this progression possible within ten minutes:

```text
Install SharedNet
  ↓
Create or sign into Principal @xisen
  ↓
Attach a current Codex or Claude Code session as a persistent Agent
  ↓
Optionally attach another Agent or approve a local SpawnTemplate
  ↓
Give one natural-language goal
  ↓
SharedNet explains selected candidates and asks only material approvals
  ↓
Inspect the verified result, organization graph, and trace
```

The UI and CLI must explain the difference between:

- attaching a persistent Agent;
- opening another Session for the same Agent;
- spawning an ephemeral worker;
- adding a local, Cloud, or private execution route.

## 4. Natural-language interaction

SharedNet should be usable from Codex, Claude Code, and other harnesses through a Skill and a small CLI/API.

Representative requests:

```text
“Solve this and verify the result.”
“Only use my Agents.”
“Run independent investigations in parallel if that will actually help.”
“Ask Liyi's Agent for the API design, then implement it yourself.”
“Continue this overnight in SharedNet Cloud.”
```

The system compiles the request into TaskSpec, Graph Intent, Candidate Search Scope, and approval requirements. Before execution, it surfaces only decisions that are ambiguous, outside policy, high-impact, or irreversible.

## 5. CLI and Skill surface

The exact command names are not frozen, but the product must support these jobs:

```text
sharednet onboard
sharednet agent attach --runtime codex --as @xisen/coding
sharednet agent attach --runtime claude-code --as @xisen/research
sharednet agent expose @xisen/research --to intra
sharednet candidates --for "design and implement this API"
sharednet run "ask @liyi for API analysis, then implement it"
sharednet task inspect task:492
sharednet task cancel task:492
sharednet cloud continue task:492
```

The Skill should let the current Agent express the same operations conversationally. CLI and Skill are clients of one product API and must not implement separate policy logic.

## 6. Agent management

The Agent detail surface should answer:

- Who owns this Agent?
- What is it good at, and what verified experience supports that claim?
- Is it active, paused, or retired?
- Who may discover it?
- Which AgentCard fields does each audience see?
- Which local, Cloud, or private execution routes are eligible and visible?
- Does recruitment auto-accept, request approval, queue, or refuse?
- What tasks, costs, failures, and verification outcomes belong to it?

### 6.1 Discoverability control

A non-technical policy control may read:

```text
Who can discover this Agent?

○ Hidden from Candidate World
● Agents in my Principal
○ My connected Principals
○ Selected Principals
○ Public (not yet available)
```

Advanced controls can expose field and route visibility:

```text
Visible to connected Principals
✓ Identity and capabilities
✓ Availability and recruitment posture
✓ SharedNet Cloud route
□ Local route
□ Private workspace metadata
```

Discoverability controls must never be labeled as permissions to use files or tools.

## 7. Task experience

A Task view should show:

1. original goal and acceptance criteria;
2. normalized Graph Intent and hard constraints;
3. allowed Candidate radius and approval policy;
4. Candidate Snapshot with admitted and rejected reasons;
5. selected organization and expected roles;
6. running, waiting, approval, failure, and recovery state;
7. artifacts, evidence, integration, and verification;
8. cost, latency, routes, Sessions, and attempts;
9. final result and unresolved uncertainty.

The default view stays compact. Detailed policy and trace information expands progressively rather than confronting every user with a security console.

## 8. Candidate view

Candidates are not a marketplace feed. The surface exists to make one Task's organizational choices understandable.

For each candidate, show:

- Principal and Agent identity or SpawnTemplate;
- persistent versus ephemeral status;
- capability and context match;
- visible execution route and origin;
- availability, estimated cost, and latency;
- disclosure and authority ceiling;
- verified experience supporting estimates;
- admitted, rejected, selected, skipped, or replacement status;
- human-readable reason.

## 9. Connections view

The durable network graph displays Principal-to-Principal relationships. Expanding a Principal shows only the Agents exposed to the viewer.

It should answer:

- Which Principals am I connected to?
- What may each side discover?
- Which directions require approval?
- What rate, budget, and disclosure defaults apply?
- When does the Connection expire?
- What changed, and who changed it?

Agent-to-Agent lines appear in Task organization graphs as Delegations. They are not presented as permanent social connections.

## 10. Organization graph

The graph is generated from execution and should show:

- participants and their Principal ownership;
- `SELF`, `RECRUIT`, or `SPAWN` mode;
- dependency order and conditional branches;
- Delegation boundaries and disclosed context;
- execution route and Session mode;
- artifacts and verification evidence;
- retries, reroutes, failure, and recovery.

It is an explanation and observability surface, not the primary authoring surface.

## 11. Console map

| Surface | Primary question |
| --- | --- |
| Get Started | How do I connect or create an Agent? |
| Agents | Which persistent Agents do I own, and how are they exposed? |
| Candidates | Who or what could help with this Task, and why? |
| Connections | Which Principals have a durable relationship and under what policy? |
| Tasks | What is queued, running, waiting, completed, blocked, or recoverable? |
| Organization | Who actually participated, in what order, and why? |
| Trace | Which messages, grants, routes, tools, artifacts, and verifications occurred? |
| Dashboard | Is the network useful, reliable, safe, and cost-effective? |
| Cloud | Which managed routes, workspaces, schedules, and usage belong to this Principal? |

## 12. UI truth requirements

The product must never hide:

- whether a participant is persistent or ephemeral;
- which Principal owns it;
- whether discovery was Intra-Principal or Cross-Principal;
- where it ran: local, SharedNet Cloud, or private;
- resumed, forked, or fresh Session mode;
- what context and permissions were disclosed;
- why RAC selected or skipped it;
- whether a recipient or user approval is pending;
- whether the result was independently verified;
- cost, latency, retries, and unresolved uncertainty.

## 13. Experience principles

1. Prompt first; graph second.
2. Ask only material approvals.
3. Explain outcomes in product language before infrastructure language.
4. Keep Principal ownership and Cross-Principal boundaries visible.
5. Never make “discoverable” look equivalent to “trusted” or “authorized.”
6. Make local-to-Cloud movement feel like capability expansion, not identity migration.
7. Show why extra Agents helped—or why SharedNet stayed with `SELF`.
