# Typed events: the endpoint the protocol is waiting for — 2026-09-19

Status: **proposed**. Replaces the 2026-09-16 draft of this file, which was
written without reading `packages/protocol/` and got the central fact wrong.

## The situation in one paragraph

The typed-coordination protocol is **finished**. It is defined once, in the
research repository, vendored here under `packages/protocol/fixtures/` and
pinned by SHA-256. Its acceptance suite is finished too: 17 conformance
scenarios (93 events) and 60 fuzz logs (2,400 events), each with the admission
outcome per event and a projection digest. `src/fixtures.test.ts` already
holds the two `it.todo`s that replay them. What is missing is one thing: the
server endpoint that takes an envelope, turns it into a canonical event,
admits or rejects it, and projects it — `POST /rooms/{r}/events` and
`GET /state`. There is no design work left on the lifecycle. There is
implementation work, and it has an externally-generated pass/fail.

## What the 2026-09-16 draft got wrong, recorded so it is not repeated

That draft proposed adding `to: InstanceId[]` to the *message* envelope as a
V1.5 step ahead of the lifecycle, on the argument that per-actor addressing
carries the measured gain and the lifecycle was the expensive part. Three
errors, in increasing order of seriousness:

1. **The lifecycle is not the expensive part.** It is already specified and
   already has a test suite. The draft's whole ordering argument rested on a
   cost that does not exist.
2. **`to` was already defined, and not as an array.**
   `envelope.schema.json` says `"to": {"type": "string", "description":
   "addressed assignee (work.request)"}`. The PR that implemented the draft
   (#113, closed) shipped an array *and* required every element to be an
   active member.
3. **It would have rejected the only traffic there is.** RAC posts typed
   envelopes into production Rooms today, carried in a `sharednet-typed:`
   trailer inside message content because the envelope cannot hold them yet.
   From `rom_f8662Y1uk1` #9: `{"type":"work.request","work_id":"W1",
   "to":"builder-1","task":"…"}`. `to` is a role name. Under #113 that would
   have 422'd the moment the trailer moved onto the envelope — the exact
   opposite of the goal.

The gate did not catch any of this, because it checks the type enum and the
lock, not message fields. PR 1 below closes that hole.

## The two shapes, which is what actually confused the draft

There are two envelope shapes and both are correct. `envelope.schema.json`
says so in its own description: *"What an agent posts. A room turns it into a
canonical event (see `event.schema.json`) and admits or rejects it."*

| | agent-facing envelope | canonical event |
|---|---|---|
| Defined in | `envelope.schema.json` (vendored) | `event.schema.json` (**not vendored** — see PR 1) |
| Who writes it | the agent | the room |
| `to` | one string: the addressed assignee | a list of targets |
| `actor` | absent | added by the room from the authenticated sender |
| clauses | `requires` | `clauses` |
| Example | `{"type":"work.request","to":"builder-1","task":"…"}` | `{"type":"work.request","actor":"A","to":["B"],"clauses":[],"parents":[],…}` |

`actor` being absent from the wire is a property worth keeping deliberately:
an agent cannot claim to have been someone else, because it never supplies
the field. The room fills it in from the credential.

## Identity: no role table, ever

`to: "builder-1"` is a role inside a RAC episode, not a seat. The obvious fix
— have the Room keep an episode-scoped table binding role names to seats — is
**rejected**, because `2026-09-06-every-member-is-an-instance.md` already
rejected the same shape for the same reason:

> It made "who is speaking" mean "someone who had my invite and typed this
> name". […] nobody else would exist on the Network page; **nothing could ever
> be delegated to anyone.** […] *guest or not is only how you were invited;
> everything belongs to a Principal through an Instance.*

The RAC mirror reproduces exactly that: `rom_f8662Y1uk1` holds 13 messages
from 2 seats, one of them named "mirror only", carrying three roles
(`arm:rge`, `builder-1`, `parser`) between them. One seat speaking for many
actors is the model that decision threw out.

So the direction is the one the decision already set: **a RAC sub-agent
becomes a real Instance, and `to` carries its Instance id.** An Instance id is
a string, so this needs no protocol change at all — `to` stays exactly what
the schema says. The cost objection (a benchmark minting hundreds of seats)
is answered by `2026-09-06-reach-public-or-private.md` §2a, which sizes the id
space for a billion Instances and states that rows are never collected and
"the tables only grow, which is the intended shape".

That work is RAC-side and is not in this roadmap. What is in this roadmap is
not blocking it: the server accepts `to` as an opaque string and does not
require it to name a member, so the mirror keeps working throughout.

## The PRs

Three of the first four are pure functions checked against 2,493
externally-generated events. None of them needs a database, an HTTP server, or
a working local checkout to be verified.

**PR 1. Vendor `event.schema.json` and make the two shapes agree.**
The canonical schema the fixtures are written in is referenced by
`envelope.schema.json` and is not vendored here, so nothing checks that the
fixtures and the envelope describe a coherent pair. Vendor it, pin it in
`FIXTURES.lock.json`, and add a gate: every event in `conformance.json` and
`fuzz.json` validates against it.

*Proves it:* the new gate fails if a vendored file drifts from the lock, and
fails if any fixture event does not validate. Re-running it against today's
files is the check that the pair is coherent to begin with — and it is the
gate that would have caught #113.

**PR 2. Envelope → canonical event.**
`parseEventEnvelope` (agent-facing, `additionalProperties: false`) and
`toCanonicalEvent(sender, envelope)`. `to: string` becomes a one-element
target list; `requires` becomes `clauses`; `actor` comes from the
authenticated sender and is refused if the body supplies it.

*Proves it:* a parser test per clause kind and predicate shape, accepting the
valid form and rejecting each malformed one; a test that an envelope carrying
`actor` is refused; a test that the RAC envelope actually in production today
(`{"type":"work.request","work_id":"W1","to":"builder-1","task":"…"}`) parses
and maps, so the trailer can move without a client change.

**PR 3. Admission.**
`admit(state, event) → { accepted, code }`, implementing Table 4 of the
paper's Appendix A against the projection.

*Proves it:* every `accepted` and `code` in all 17 conformance scenarios and
all 60 fuzz logs — 2,493 events — with no HTTP and no database. Each named
scenario is its own case, so a failure names the rule it broke
(`wrong_actor_acceptance`, `veto_is_fail_fast`, `clock_must_be_monotone…`).

**PR 4. The projection, and the digest.**
The fold, `binding` per admitted event, and the content digest of the
projection.

*Proves it:* `binding` per event plus the final digest equal to each
fixture's. **This flips the first `it.todo` green.**

**PR 5. Persistence and the endpoints.**
An event log, `POST /rooms/{r}/events`, `GET /rooms/{r}/state`. A typed Room
validates; an unvalidated Room stores the same envelope opaquely, which is
the `tagged` condition RAC runs today.

*Proves it:* handler tests for the success path and each error code; the
replay suite runs over real HTTP against the in-memory repository; the
memory and PostgreSQL repositories agree. **Both `it.todo`s green.**

**PR 6. CLI and MCP.**
`sharednet request/accept/deliver/verify/resolve`, `sharednet open`, and the
MCP resource + tools + `notifications/resources/updated`.

*Proves it:* `cli.test.ts` on exact request bodies; `test:package:cli` from
the packed tarball; the MCP tests over the real handler.

**PR 7 (RAC-side, tracked not owned). The trailer moves onto the envelope,**
and sub-agents take real Instances so `to` becomes an Instance id.

## Open questions

- **The fixtures address abstract names** (`members: ["A","B","C","D","E"]`,
  `to: ["B"]`). The replay harness needs a fixture-only mapping from those
  names to seats. Production uses Instance ids; the mapping must not leak out
  of the test.
- **Room protocol pin.** A Room that validates and a Room that stores
  opaquely are different contracts, and `POST /rooms { protocol? }` is how the
  paper's version non-retroactivity is kept. Decide in PR 5 whether the pin
  lands there or immediately after; the UI shows two options either way and
  upgrading is a successor Room, never a mutation.
- **`work_id` is agent-supplied** (`^W[0-9]+[a-z]?$|^[A-Za-z0-9_.:-]{1,64}$`),
  so it is unique per Room, not globally. Worth stating explicitly before it
  is assumed to be a server-minted id.

## What is not here

Addressing as a separate milestone, role tables, `to` on plain messages, and
per-actor filtering as its own feature. Per-actor obligation is what
`GET /state` returns once actors are real Instances; it is an output of this
work, not a step in it.
