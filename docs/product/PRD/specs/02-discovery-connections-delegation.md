# Discovery, Connections, and Delegation

> **Status:** Working specification
>
> **Normative for:** Intra/Cross-Principal discovery, Principal relationships, recruitment, delegation contracts, recipient ownership
>
> **Parent:** [`../../PRD.md`](../../PRD.md)

## 1. Purpose

SharedNet must let Agents find useful collaborators without turning discovery into authority or forcing users to manage a friendship graph between every Agent pair.

The model has three distinct layers:

```text
Principal Connection
  → who has a durable relationship and may approach whom

Agent exposure and AgentCard projection
  → which Agents and fields this caller may discover

Task-scoped Delegation Contract
  → what one selected Agent may ask another to receive, do, and return
```

SharedOS grants remain the final point-of-use authority.

## 2. Two-sided discovery policy

Discovery is the intersection of requester and provider intent.

### 2.1 Requester search scope

Every Task has a maximum search radius called its **Task Search Scope**:

| Scope | Meaning |
| --- | --- |
| `intra_principal` | Search the requesting Agent, sibling persistent Agents exposed inside the Principal, and allowed spawn templates |
| `connected_principals` | Also search Agents exposed by accepted Principal Connections |
| `selected_principals` | Search only the named Principals in addition to allowed local candidates |
| `public` | Reserved for a later release; not part of V0/V1 defaults |

The Principal sets a default. A user prompt may narrow it, or explicitly expand it within the Principal policy ceiling:

```text
“只用我的 Agents”                 → intra_principal
“必要时可以找我的 connections”   → connected_principals
“先联系 Liyi”                    → selected_principals: [@liyi]
```

RAC can never widen beyond the effective task scope.

### 2.2 Provider exposure policy

Each Agent owner independently controls exposure. The underlying policy is a matrix rather than one `discoverable` Boolean:

```yaml
discovery:
  intra_principal: true
  connected_principals: true
  principal_allowlist:
    - principal:liyi
  public: false
card_visibility:
  connected_principals:
    fields: [identity, capabilities, availability, recruitment, experience_summary]
    execution_routes: [sharednet_cloud]
```

The product may offer presets:

- **Hidden from Candidate World**;
- **My Principal only**;
- **Connected Principals**;
- **Selected Principals**;
- **Public** later.

The owner/admin can always manage the Agent. A hidden Agent may be explicitly selected by its owner if policy allows, but it is absent from autonomous discovery. A foreign caller cannot bypass hidden status by knowing the exact ID.

### 2.3 Effective discovery

```text
DiscoverableCandidates(task, caller)
= TaskSearchScope(caller)
∩ AgentExposure(provider)
∩ PrincipalRelationship(caller, provider)
∩ OriginRestrictions(task)
```

Discoverability only makes a projected card eligible for Candidate World construction. Admission still checks availability, acceptance, environment compatibility, cost, and authority.

## 3. Properties that must remain separate

SharedNet must not collapse these properties:

| Property | Question |
| --- | --- |
| Existence visibility | May this caller know the Agent exists? |
| AgentCard visibility | Which capabilities, routes, evidence, and status may the caller see? |
| Addressability | May the caller resolve a stable destination? |
| Reachability | Is there a currently usable inbox or execution route? |
| Recruitability | May the caller propose a task, and is acceptance automatic or manual? |
| Authority | Which protected actions may occur after point-of-use authorization? |

In shorthand:

```text
Identity ≠ discovery ≠ reachability ≠ recruitment ≠ authority
```

## 4. Principal Connection

A **Connection** is a versioned, durable relationship between two Principals.

It provides:

- verified counterpart identity;
- a policy-controlled path for AgentCard projection and task proposals;
- directional defaults for disclosure, approvals, rate limits, and cost;
- expiry, suspension, and revocation;
- audit lineage for Cross-Principal interaction.

The relationship may be mutually accepted while its effective terms remain directional. `@xisen` may expose different Agents and auto-accept rules to `@liyi` than `@liyi` exposes to `@xisen`.

A Connection does not:

- expose every Agent owned by either Principal;
- create a grant to read files or use tools;
- force a recipient Agent to accept work;
- allow onward delegation;
- remain effective after suspension or revocation.

### 4.1 Same-Principal behavior

Agents under one Principal do not create persistent Connections with one another. Principal policy provides the maximum Intra-Principal discovery and recruitment posture.

Common ownership may allow automatic acceptance and lower approval friction, but it does not imply shared secrets, shared writable workspaces, or unrestricted tools. Every task edge still receives a Delegation Contract and SharedOS grants.

## 5. Recruitment

`RECRUIT` selects an existing persistent Agent. It may be Intra-Principal or Cross-Principal; the semantic action is the same, while discovery, acceptance, transport, and disclosure policies differ.

Cross-Principal recruitment defaults to:

1. accepted Principal Connection or explicit invitation path;
2. caller-relative AgentCard projection;
3. recipient-owned task proposal and acceptance;
4. text/artifact-only disclosure posture;
5. no requester workspace or tool authority unless separately and explicitly granted;
6. origin and disclosure restrictions propagated through every downstream hop.

Preauthorization may reduce repeated approval only when both Principal policy and Agent recruitment policy allow it. Preauthorization never bypasses per-action SharedOS checks.

## 6. Delegation Contract

Every `RECRUIT` edge creates a task-scoped contract containing:

```yaml
delegation_id: delegation:task-492:api-advisor
task_id: task:492
requester:
  principal: principal:xisen
  agent: agent:xisen:coding
recipient:
  principal: principal:liyi
  agent: agent:liyi:api
role: api_design_advisor
goal: analyze the proposed API design
deliverable: recommendation_with_evidence
disclosure:
  context: api_contract_only
  artifacts: [openapi_excerpt]
capability_ceiling: [message_reply, artifact_return]
onward_delegation: deny
limits:
  max_turns: 4
  deadline: task_deadline
  cost: task_allocated
verification: evidence_required
expiry: task_defined
```

The contract also records cancellation, revocation, retry, reply destination, and artifact retention semantics.

The contract is a product-level intent and ceiling. It compiles into SharedOS grants; SharedNet must not implement a second point-of-use authorization engine.

## 7. Recipient ownership

Recruitment never transfers ownership of an Agent, Environment, Session, files, tools, credentials, or accumulated experience.

The recipient may:

- accept;
- reject;
- narrow requested disclosure or capabilities;
- delay until available;
- cancel before completion;
- return only contract-approved outputs and evidence.

A requester cannot force a particular local or Cloud route unless the recipient exposes and accepts it.

## 8. Signature Cross-Principal flow

For “contact Liyi's Agent for API analysis”:

```text
1. Parse explicit Cross-Principal Graph Intent
2. Resolve @liyi and validate Principal relationship
3. Request AgentCard projections visible to @xisen
4. Build and admit matching candidates
5. RAC selects @liyi/api
6. Create task-scoped Delegation proposal
7. Recipient accepts, rejects, or narrows
8. Compile accepted contract to SharedOS grants
9. Route to an eligible recipient-owned execution endpoint
10. Return approved reply, artifacts, and evidence
11. Wake/resume the requesting Task
```

If identity resolution is ambiguous or the requested Principal is outside the policy ceiling, SharedNet asks the user rather than silently substituting another collaborator.

## 9. Default product policy

For the initial releases:

- Intra-Principal discovery may be enabled per Agent and is the V0 default radius.
- Intra-Principal recruitment may auto-accept within owner budget and disclosure policy.
- Cross-Principal AgentCard discovery requires an accepted Principal Connection or explicit selected-principal path.
- Cross-Principal recruitment requires explicit prompt intent, user approval, or preauthorization.
- Public discovery is not included in V0 or required for V1.
- Route and field visibility remain independently configurable.

## 10. Required invariants

1. Persistent Connection edges are Principal-to-Principal.
2. Agent-to-Agent collaboration is represented by task-scoped Delegation.
3. Provider exposure and requester search radius are independently enforced.
4. Discovery and exact IDs never create recruitment or execution authority.
5. Revocation is checked before protected execution and Cross-Principal delivery.
6. Origin restrictions may only narrow across delegation hops.
7. Recipient ownership survives every recruitment.
