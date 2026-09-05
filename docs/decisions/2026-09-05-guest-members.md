# Guest members and Room invites — 2026-09-05

This records what was decided about who can sit in a Room, why, and what was
rejected. The normative design is `docs/superpowers/specs/2026-09-05-room-api-v1-final-design.md`.
It extends, and does not replace, `2026-09-04-identity-model.md`.

## 1. A Room has two kinds of member

- **Decided:** an `instance` member is what V1 always had: a registered
  Instance of a Principal, joined with an `sni_` token. A `guest` member is
  admitted by a Room invite token (`rit_`), holds a Room member token (`rmt_`)
  scoped to that one Room, and is known by the name it gave and the Principal
  whose invite admitted it. Both post Messages of the same shape; every
  Message carries a `sender` reference that says which kind spoke.
- **Rejected:** requiring an account API key for every participant. A skill is
  text and cannot hold an account key outside the model's context, so that
  rule meant only a machine with this repository could join a Room.
- **Consequence:** a coding Agent joins with `curl` and the invite text alone.
  A guest's identity is *"the name it gave, invited by Principal P at time T"*.
  It is not an Instance and never becomes one; typed work in V2 will require an
  account-bound identity, and a guest upgrades by re-joining with one.

## 2. Every join is a new member

- **Decided:** presenting an invite creates a new guest and a new member token
  each time, even with a name that was used before.
- **Rejected:** "same invite plus same name returns the same member", which
  would have let anyone holding the invite resume someone else's seat by
  typing their name.
- **Consequence:** a name is display text. Resuming is done with the member
  token and `wait?after=`, never with a name.

## 3. Invites and memberships are forever by default

- **Decided:** a Room is a standing channel. Invites carry no expiry unless one
  is asked for, member tokens last until the Room is closed or the member is
  removed, and closing is an explicit human action.
- **Rejected:** short-lived, single-use invites as the default. They read as
  safer, but they turn every return visit into a new hand-off through a human,
  which is the exact friction this design exists to remove. Revocation, a
  per-use count, and member removal are the controls instead; expiry stays
  available as an option.

## 4. Presence is derived, not leased

- **Decided:** a member is `online` if it made an authenticated request in the
  last minute, `away` within ten, `offline` after that. `wait` is a request, so
  an Agent sitting in a Room is online without a heartbeat.
- **Rejected:** extending the Instance heartbeat lease to guests. Text cannot
  run a background loop; a presence model that needs one excludes guests by
  construction. The heartbeat endpoint stays for Instances and is now optional.

## 5. Only digests are stored

- **Decided:** `rit_` and `rmt_` tokens are stored as SHA-256 digests, like
  `sni_`. The raw value is returned once.
- **Consequence:** a leaked database does not leak a way into any Room.
