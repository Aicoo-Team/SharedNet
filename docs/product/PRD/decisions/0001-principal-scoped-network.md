# ADR 0001 — Principal-scoped network relationships

> **Status:** Accepted
>
> **Date:** 2026-08-26
>
> **Affects:** identity, discovery, Connections, AgentCards, Candidate World, Delegation

## Context

SharedNet needs to support:

- multiple persistent Agents owned by one account;
- Intra-Principal local organization;
- Cross-Principal discovery and recruitment;
- per-Agent discoverability;
- local, Cloud, and private execution routes;
- durable trust relationships without an unmanageable Agent-to-Agent social graph.

The previous unified PRD allowed a Connection to exist “between Agents or principals.” That ambiguity creates two competing trust graphs and makes it unclear whether adding, replacing, or pausing an Agent changes durable relationships.

A single `discoverable` Boolean is also insufficient. It cannot express caller-relative cards, private local routes, connected-Principal visibility, allowlists, recipient acceptance, or the distinction between discovery and authority.

## Decision

1. Every SharedNet account maps to a stable **Principal**.
2. A Principal owns multiple persistent Agents and their policy source.
3. Durable network **Connections are Principal-to-Principal**.
4. Each Agent independently defines who may discover it and which AgentCard fields and execution routes each audience may see.
5. A Task independently defines its allowed Candidate search radius: Intra-Principal, connected Principals, or selected Principals.
6. Effective discovery is the intersection of requester scope, provider exposure, relationship, origin restrictions, and admission constraints.
7. Agent-to-Agent work is represented by a **task-scoped Delegation Contract**, not another persistent Connection.
8. Same-Principal Agents do not need durable Connections. Principal policy may reduce approval friction, but Delegation and SharedOS authorization remain task-scoped.
9. Local, SharedNet Cloud, and private VPC are execution-route metadata on caller-relative AgentCards, not separate Agent identities.

## Consequences

### Positive

- The durable trust graph stays small and legible.
- Adding or replacing an Agent does not require rebuilding every relationship.
- A Principal can expose only selected Agents to each relationship.
- Local routes can remain private while the same Agent exposes a Cloud route externally.
- The model matches the intuitive account/contact behavior already demonstrated by Aicoo.
- Intra-Principal and Cross-Principal work use one coordination engine with different policy radii.
- Delegation, origin, disclosure, and authority stay attributable to one Task.

### Costs

- AgentCards must be projected per caller rather than globally cached as one public record.
- Connections require directional policy even when mutually accepted.
- Candidate World construction must intersect both sides' policies.
- Product UX must explain that discovery, recruitment, and authority are different.
- Existing language and schemas that model same-Principal Agent Connections must be migrated.

## Rejected alternatives

### Persistent Agent-to-Agent Connections

Rejected because the graph grows with every Agent pair, duplicates account-level trust, and becomes unstable as Agents are created, retired, or replaced.

Agent collaboration history may still inform RAC experience, but it is not a durable security relationship.

### One global `discoverable` flag

Rejected because it cannot express audiences, field filtering, route visibility, task origin, or recipient-controlled recruitment.

### Public marketplace as the primary network

Rejected as the default because SharedNet first needs trusted useful work across one Principal and explicit Principal Connections. Public discovery may be evaluated later without changing the core model.

### Separate local and remote Agent identities

Rejected because placement would fragment memory, reputation, policy, and Task lineage. One Agent may advertise multiple eligible execution routes.

## Required follow-through

- Treat Principal as the owner and relationship root in every schema and UI.
- Remove same-Principal Connection objects from V0 requirements.
- Add Agent exposure and caller-relative AgentCard projection.
- Keep Task Search Scope separate from Agent exposure.
- Model every selected Agent-to-Agent edge as a Delegation.
- Keep execution routes as AgentCard metadata and trace their actual selection.
