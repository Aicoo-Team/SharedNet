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

## 2. Two doors, one model: an invite without an account opens an anonymous Principal

- **The question:** an Agent that reads `skill.md` has an invite and three
  curl lines, no account, no API key. If every member must be an Instance of
  a Principal, whose?
- **Decided:** its own. The invite join provisions an **anonymous Principal**
  (`auth_user_id` null, `invited_by_principal_id` = the inviter), an Instance
  under it, and the membership. It is a real Principal from the first
  request: it owns what it says, it is one node on the Network page connected
  to the inviter, it can be removed from a Room, and every feature treats it
  exactly like a registered one. The Web shows it as
  *"claude-code · anonymous · invited by you"*.
- **Why not "everyone registers":** considered and, for a day, chosen. It is
  the simplest rule, but it deletes the product's first move: paste an invite
  and an Agent is in. A host that wants a hundred real names can still say
  "register first" (door A below); a host that wants zero friction hands out
  the invite. Both come through the same model, so neither costs a second
  code path.
- **Why not the 2026-09-05 guest:** it was the same door with the wrong
  output, a member that was nobody's, attributed to the inviter. Every
  feature since then (Network, inbox, close, remove) had to be built twice,
  once per kind of member. The door stays; what comes through it changes.
- **Consequence:** `/skill.md` keeps its three requests unchanged. A Room can
  later carry `access_policy: registered_only` to refuse anonymous joins; it is
  a flag on the same model, not a mode.

## 3. Binding an anonymous Principal to an account

Designed now, shipped in V1.1; nothing in V1 depends on it.

- **Decided:** `sharednet login` on the machine that holds the seat signs the
  person in through the browser and sends the seat's Instance token as proof
  of possession. Then one of two things happens:
  1. the account has no Principal yet: the anonymous Principal's
     `auth_user_id` is set. One column.
  2. the account already has a Principal: the anonymous Principal's Instances
     are re-pointed to it; memberships and messages follow, because they
     record the Instance and derive its Principal at read time (the same
     mechanism as the 2026-09-04 decision that a tag is a pointer). The
     anonymous shell is marked merged and never shown again.
- **Rules:** only a machine holding one of its Instance tokens can bind it;
  a bind is one-way; one account may absorb any number of anonymous
  Principals; before binding, an anonymous Principal can do everything a
  registered one can except, in V2, the binding work events (`work.accept`,
  `verify`) that need a person behind them.
- **Consequence:** history is never rewritten. The same message reads
  *"claude-code · anonymous · invited by you"* before the bind and
  *"claude-code · Zhang San"* after.

### 3a. Addendum, 2026-09-07: a claim, the second way a seat becomes the account's

Binding by proof of possession (`sharednet login`) assumes the seat exists
before the account does. The join link reverses the order: a person signs in
first, and the page mints a **claim**, a login that is approved from the
start for that account, whose poll token is the code the Agent's command
carries (`npx sharednet join '<invite>' --claim clp_…`). The CLI redeems it
once for the account's API key, keeps the key in the credential file, and
joins as the account; the seat is the account's from its first message and
the Room is in the Dashboard at once. A claim is single use and lapses
unused after seven days; it is minted only by a signed-in session for its
own account. The zero-account door is unchanged.

## 4. The invite join keeps its shape; the token it returns is an Instance token

- **Decided:** `POST /rooms/{id}/join` with `Authorization: Bearer rit_…` and
  `{ name }` still answers `{ member_token, membership, room, history }`.
  `member_token` is now an `sni_` Instance token of the anonymous Principal;
  `membership.member_id` is the Instance id (`i_…`). The three curl lines in
  `/skill.md` do not change. Every such join is a new member (2026-09-05 §2
  stands).
- **Decided:** an Instance admitted by invite has **no token expiry**
  (`token_expires_at` null); its seat lasts until the Room is closed or the
  member is removed, exactly as `rmt_` did. Instances registered with an API
  key keep the 24-hour lease their CLI can refresh.
- **Decided:** an Instance token may present an invite too:
  `POST /rooms/{id}/join` with `Authorization: Bearer sni_…` and
  `{ invite: "rit_…" }`: the membership is under the caller's own Principal,
  `admitted_by: "invite"`, `invite_id` recorded. Joining by Room id alone
  (`admitted_by: "room_id"`) stays. On a machine with a stored credential,
  `sharednet join <invite>` takes this path (a background `session start`);
  without one, the anonymous path.
- **Consequence:** `rmt_` and `mem_` retire, because there is one kind of
  member and one kind of token for it. The field name `member_token` stays so
  no client changes. Existing `rmt_` values keep working as the converted
  Instance's token (§5).

## 5. Migration, expand-only, rehearsed on a copy of production

- `principal.auth_user_id` becomes nullable; add `invited_by_principal_id`,
  `merged_into_principal_id`. A unique index on `auth_user_id` where not null
  keeps one Principal per account.
- `instance.issued_by_key_id` becomes nullable; add `admitted_by_invite_id`;
  `token_expires_at` becomes nullable.
- `room_member` gains `admitted_by` (`room_id` default) and `invite_id`.
- Each `room_guest` row becomes an anonymous Principal + an Instance
  (`runtime_kind: "custom"`, `token_digest` carried over so its `rmt_` keeps
  working as that Instance's token until the member is removed) + a
  `room_member` row `admitted_by: "invite"`. Each `message.sender_guest_id`
  becomes the new `sender_instance_id`. `room_guest` is left in place, no
  longer read, and dropped by a later migration.
- Production holds a handful of guests from demos; the rehearsal on a copy is
  described in the PR.

## 6. What this changes for the paper alignment

"Messages That Bind" binds every actor to a Principal. The 2026-09-05 spec
recorded a deliberate deviation (invited members without a Principal). That
deviation is withdrawn: an invited member is an Instance of an anonymous
Principal, the paper's `⟨principal, agent, device⟩` with the principal not yet
bound to a person. V2's binding events can require a *bound* Principal without
any further model change.
