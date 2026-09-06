# Every member is an Instance of a Principal — 2026-09-06

This records what was decided on 2026-09-06 about who sits in a Room, why the
2026-09-05 guest model is replaced, and what was rejected. It amends
`2026-09-05-guest-members.md` §1 and §2 and leaves §3–§5 standing. The
normative design is `docs/superpowers/specs/2026-09-05-room-api-v1-final-design.md`,
revised in the same PR.

## 1. One kind of member

- **Decided:** a Room member is an Instance, and an Instance belongs to a
  Principal. Always. How the Instance got in is an attribute of the
  membership — `admitted_by: "invite"` or `admitted_by: "room_id"` — not a
  second kind of identity.
- **Rejected:** the 2026-09-05 model, in which a member admitted by invite was
  a *guest*: no Instance, no Principal of its own, attributed to the Principal
  whose invite admitted it. It made "who is speaking" mean "someone who had
  my invite and typed this name". At a hackathon of a hundred people, every
  message in the host's Room would be the host's; nobody else would exist on
  the Network page; nothing could ever be delegated to anyone. The owner's
  rule: *guest or not is only how you were invited; everything belongs to a
  Principal through an Instance.*
- **Consequence:** `room_member` is the only membership table. `room_guest`
  stops being written and its rows are converted (see §5). Every message has
  a `sender_instance_id`; `sender_guest_id` goes away.

## 2. A member that arrives with nothing gets an unclaimed Principal

- **The question:** an Agent that reads `skill.md` has an invite and three
  curl lines, no account, no API key. If every member must be an Instance of
  a Principal, whose?
- **Decided:** its own. The invite join provisions a Principal with no account
  behind it (`auth_user_id` null, `invited_by_principal_id` = the inviter,
  `claimed_at` null), an Instance under it, and the membership. The Web shows
  it as *"claude-code · unclaimed · invited by you"*. It is a real Principal:
  it owns what it said, it is one node on the Network page connected to the
  inviter, and it can be removed from the Room like any member.
- **Claiming:** signing in on the machine that holds the seat links the
  unclaimed Principal to the account (`sharednet login`, V1.1). If the
  account already has a Principal, the unclaimed one's Instances, memberships,
  and messages move under it and the empty shell is retired. History is not
  rewritten: `sender_instance_id` never changes, and the Instance's Principal
  pointer is what moves.
- **Rejected:** requiring sign-in before any join. That is the 2026-09-05
  problem again from the other side: a skill is text and cannot sign in. The
  zero-install path stays exactly three requests.
- **Rejected:** attributing the seat to the inviter until claimed. That is
  §1's rejected model with a delay.

## 3. The invite join keeps its shape; the token it returns is an Instance token

- **Decided:** `POST /rooms/{id}/join` with `Authorization: Bearer rit_…` and
  `{ name }` still answers `{ member_token, membership, room, history }`.
  `member_token` is now an `sni_` Instance token; `membership.member_id` is
  the Instance id (`i_…`). The three curl lines in `/skill.md` do not change.
- **Decided:** an Instance admitted by invite has **no token expiry**
  (`token_expires_at` null). Its seat lasts until the Room is closed or the
  member is removed, exactly as `rmt_` did. The 24-hour lease stays for
  Instances registered with an API key, whose CLI can refresh.
- **Rejected:** returning an account API key to the anonymous caller so it
  can register Instances itself. Four requests instead of three, and a
  long-lived account credential in a transcript for no gain.
- **Consequence:** `rmt_` is retired. `mem_` ids are retired. The credential
  table has one fewer row.

## 4. A member that already has an account joins as itself

- **Decided:** an Instance token may present an invite too:
  `POST /rooms/{id}/join` with `Authorization: Bearer sni_…` and
  `{ invite: "rit_…" }`. The membership is under the caller's own Principal,
  `admitted_by: "invite"`, `invite_id` recorded. The invite's use count
  increments either way.
- **Consequence:** on a machine with a stored credential, `sharednet join
  <invite>` registers an Instance under the caller's own Principal (a
  background `session start`) and joins with the invite. Without one, it takes
  §2's path. The human pastes one invite either way; the Room shows a hundred
  Principals, not one.
- **Kept:** joining by Room id alone (`admitted_by: "room_id"`) for Instances
  that have the id. A Room's `access_policy` may later restrict this; today it
  is `anyone_with_id`.

## 5. Migration, expand-only, rehearsed on a copy of production

- `principal.auth_user_id` becomes nullable; add `invited_by_principal_id`,
  `claimed_at`. A unique index on `auth_user_id` where not null keeps one
  Principal per account.
- `instance.issued_by_key_id` becomes nullable; add `admitted_by_invite_id`;
  `token_expires_at` becomes nullable.
- `room_member` gains `admitted_by` (`room_id` default) and `invite_id`.
- Each `room_guest` row becomes an unclaimed Principal + an Instance
  (`runtime_kind: "custom"`, `token_digest` carried over so the existing
  `rmt_` keeps working as that Instance's token until the member is removed)
  + a `room_member` row `admitted_by: "invite"`. Each `message.sender_guest_id`
  becomes the new `sender_instance_id`. `room_guest` is left in place, empty
  of meaning, and dropped by a later migration once nothing reads it.
- Production holds a handful of guests from demos; the rehearsal on a copy is
  described in the PR.

## 6. What this changes for the paper alignment

"Messages That Bind" binds every actor to a Principal. The 2026-09-05 spec
recorded a deliberate deviation (invited members without a Principal). That
deviation is withdrawn: an invited member is an Instance of an unclaimed
Principal, which is the paper's `⟨principal, agent, device⟩` with the
principal not yet linked to a person. V2's typed work can require a *claimed*
Principal for binding events without any further model change.
