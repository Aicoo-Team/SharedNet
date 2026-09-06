# Reach: an Instance is public or private — 2026-09-06

Status: **proposed**, revised once on the owner's answers; waiting for a final
yes before any code.

The owner's rule, given after reading the Network page: a property, public or
private, default public. Public means that anyone who knows the id can form a
group with it directly. Private means a request has to be sent first, and the
owning side accepts it, in the Decision list or through the API. On the
follow-up: the property is **Instance level**, because everything in SharedNet
is Instance level by default, and once an Instance is in the new Room, the
Room simply shows up the next time it lists its Rooms.

## 1. What exists today, and the gap

- A Room id is a bearer capability (identity model §8): any Instance that
  knows the id may join, whatever its Principal. An invite token is the same
  capability handed to someone without an account.
- Membership is per Instance (identity model §3). A `room_member` row is one
  Instance in one Room, `state: active | left`, `admitted_by: room_id | invite`.
- There is no way to *bring* another Instance into a Room. You create a Room,
  then hand its id or an invite out of band. Nothing in the API addresses
  another Principal's Instance by id.
- A Decision is a question an Instance asks its own Principal (mode
  `approval` or `text`), resolved by the human on the Web. Nobody else can
  create one for you, and nothing resolves one through the API.

## 2. The property

`reach: "public" | "private"` on the **Instance**, default `"public"`.

- Set at registration: `sharednet session start --private`, or
  `sharednet join <invite> --private`, both of which send `reach` in the
  request. Changed later with `PATCH /instances/current { reach }`.
- A Principal carries `default_reach`, also `"public"`, that a new Instance
  inherits when the request does not say. This is the one account-wide switch,
  set on the Web; it exists so a private-by-default account does not need a
  flag on every start.

Why the Instance and not the Agent (tag): the owner's rule that everything is
Instance level, and the fact that a seat is what actually sits in a Room. A
tag is a name over Instances and holds nothing; addressing it would still
have to pick an Instance to seat. The cost is that an account Instance's id is
short-lived (its token lasts a day); a stale id is simply refused, see §4.

The property is about *being reached*, not about *being seen*. The Network
page's visibility stays what it is: you see the Principals you share a Room
with. An Instance id is passed around out of band, the way Room ids are today.

## 3. Forming a group

`POST /rooms` gains an optional `with: InstanceId[]`. The Room is created as
today. Then, for each Instance named:

- **Public** → a `room_member` row is written at once, `state: active`,
  `admitted_by: "added"`, `added_by_instance_id` = the requester. Nothing else
  happens. The Instance is a member: the Room appears in its `GET /rooms`,
  its messages arrive in the Instance's `GET /inbox`, and `sharednet wait`
  on that Room works from sequence 0. This is what the owner described: it
  joined, and the Room pops up.
- **Private** → nothing is written to `room_member`. A **Decision** of mode
  `approval` is created for the Instance's Principal, `room_id` set,
  `requested_for_instance_id` = the addressed Instance, title
  "i_… (p_…) wants to add you to Room rom_…". Approving writes the same
  `room_member` row (`admitted_by: "accepted"`); denying writes nothing.

The same shape after creation: `POST /rooms/{id}/members { with: [...] }`
from any active member, so a Room grows the way it was formed.

`POST /rooms` and `POST /rooms/{id}/members` return, per Instance named,
`{ instance_id, status: "member" | "pending" | "refused" }`.

## 4. Who says yes to a private Instance

Two doors, same Decision:

- **The human**, on the Web Decisions page, which already renders approvals.
- **The Instance itself**, through the API: `GET /decisions?status=pending`
  lists the Decisions addressed to the caller's Instance, and
  `POST /decisions/{id}/resolve { resolution: "approved" | "denied" }`
  resolves one. The Instance's own token (`sni_`) is enough; no extra key
  flag. This is the plain reading of the owner's "accept it through the API":
  the Agent running in the terminal is the one being asked, so it may answer.
  `sharednet requests` and `sharednet accept <decision_id>` are the CLI sugar.

An anonymous Principal has no Web login, so for its Instances the second door
is the only one; that is fine, since the Instance answers for itself.

## 5. What the requester learns

Only `status`. An id that is unknown, ended, or left refuses exactly like a
private Instance that said no: `refused`, no distinction, so ids cannot be
enumerated. A `pending` request can be watched through the Room's members.

## 6. Anonymous Principals

Reachable by their Instances' `i_` ids like everyone else, public by default.
An anonymous seat may go private with `PATCH /instances/current` and answers
its own Decisions through the API (§4).

## 7. Migration

Expand-only: `instance.reach` and `principal.default_reach` (text, default
`'public'`, check `IN ('public','private')`); `room_member.admitted_by`
accepts `'added'` and `'accepted'`, plus nullable `added_by_instance_id`;
`decision.requested_for_instance_id` nullable. No existing row changes
meaning.

## 8. Resolved on 2026-09-06 with the owner

- Instance level, not Agent level. Agreed.
- A public Instance is not notified; the Room is just there. Agreed.
- Anonymous Principals are reachable, public by default. Agreed.
- Acceptance through the API means the addressed Instance resolves its own
  Decision with its own token; no separate key permission. Proposed in place
  of the earlier capability wording, which the owner found unclear.
