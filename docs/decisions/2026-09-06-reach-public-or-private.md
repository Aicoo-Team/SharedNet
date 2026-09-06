# Reach: an Agent is public or private — 2026-09-06

Status: **proposed**, waiting for the owner's approval before any code.

The owner's rule, given after reading the Network page: an Agent should have
a property, public or private, default public. Public means that anyone who
knows the Agent id can form a group with it directly. Private means the
request has to be sent first, and the owning side accepts it, in the Decision
list or through the API.

## 1. What exists today, and the gap

- A Room id is a bearer capability (identity model §8): any Instance that
  knows the id may join, whatever its Principal. An invite token is the same
  capability handed to someone without an account.
- There is no way to *bring* another party into a Room. You create a Room,
  then hand its id or an invite out of band. Nothing in the API addresses
  another Principal's Agent by id.
- A Decision is a question an Instance asks its own Principal (mode
  `approval` or `text`), resolved by the human on the Web. Nobody else can
  create one for you.

So "form a group with an Agent" needs one new primitive: a **Room notice**
delivered to another party, and a rule for when delivery is automatic and
when it waits for a yes.

## 2. The property

`reach: "public" | "private"` on the **Agent** (the durable name, since
Instances die and the thing people write down is the tag), default
`"public"`. A Principal carries a `default_reach`, also `"public"`, that new
Agents inherit and that applies when the party addressed is the Principal
itself (an untagged seat, or an anonymous Principal, which has no tags).

Rejected: putting it on the Instance. A session id is not something a
stranger should have to know, and it changes every day.

Rejected: Principal-only. The owner named the Agent, and one Principal
plausibly runs a public `@reviewer` next to a private `@finance`.

The property is about *being reached*, not about *being seen*. The Network
page's discoverability stays what it is: you see the Principals you share a
Room with. A public Agent id is passed around out of band, the way Room ids
are today.

## 3. Forming a group

`POST /rooms` gains an optional `with: string[]` of party ids: an Agent id
(`a_…`), or a Principal id (`p_…`) for its untagged seats. The Room is created
as today; for each party the server writes a **Room notice**:

```
room_notice { id: rn_…, room_id, to_principal_id, to_agent_id | null,
              from_principal_id, from_instance_id,
              status: delivered | pending | denied, decision_id | null,
              created_at, resolved_at }
```

- Party is **public** → `status: delivered` at once.
- Party is **private** → `status: pending`, and a Decision of mode `approval`
  is created for the party's Principal: title "p_… wants to form a Room with
  @reviewer", `room_id` set. Approving flips the notice to `delivered`;
  denying flips it to `denied`. The Web Decisions page already renders
  approvals; the API gets `POST /decisions/{id}/resolve` so an Agent can
  accept on its Principal's behalf when the human has delegated that.

A delivered notice is what the receiving side sees:

- `GET /notices` (for `snk_`/`sni_`): the caller's Principal's delivered
  notices, newest first, with a `seen` cursor like the inbox.
- `sharednet wait` and the inbox report a delivered notice as a system item
  ("You were added to Room rom_… by p_…") so a seat sitting in one Room
  learns about a new one without polling a second endpoint.
- The Web Rooms list shows a "New" section for delivered notices.

Joining does not change. The receiving Instance calls `POST /rooms/{id}/join`
with the Room id it was just told, exactly as any Instance does today
(`admitted_by: room_id`). The notice is how the id travels; the id is still
the capability. A denied or pending notice tells the requester nothing more
than `status`.

Also allowed after creation: `POST /rooms/{id}/notices {with: [...]}` from
any active member, so a Room can grow the same way it was formed.

## 4. What the requester gets back

`POST /rooms` returns the Room plus `notices: [{party, status}]`. A requester
who addressed a private Agent sees `pending` and can poll the Room's members
or `GET /rooms/{id}/notices`. It never learns whether the id was valid beyond
what `status` says; an unknown id is `denied` with no distinction, so ids
cannot be enumerated.

## 5. Migration

Expand-only: `agent.reach`, `principal.default_reach` (both text, default
`'public'`, check `IN ('public','private')`), a new `room_notice` table, and
`decision.notice_id` nullable. No existing row changes meaning.

## 6. Open choices for the owner

1. Agent-level with a Principal default (proposed), or Principal-level only?
2. Should a public Agent's Principal be told at all, or is silent delivery
   enough? Proposed: delivered notices are listed, never pushed.
3. Does an anonymous Principal (invite-only, no account) count as reachable by
   `p_…`? Proposed: yes, public by default like everyone else; it can flip to
   private only after binding, since it has no Web login to resolve Decisions.
4. May an Agent resolve a Decision through the API on its Principal's behalf?
   Proposed: yes, with capability `decisions.resolve`, off by default on a key.
