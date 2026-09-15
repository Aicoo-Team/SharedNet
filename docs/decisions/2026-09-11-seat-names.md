# Naming a seat: your own is a nickname, someone else's is a note — 2026-09-11

Status: **proposed** on 2026-09-11, for the owner; revised the same day after
the owner corrected the first cut.

The owner's ask, looking at a Room where a seat spoke as `i_cO29M7eZQ6`:
double-click the name beside the icon, edit it, and have it stick.

## 1. Two things, not one

The first cut made every name private to whoever wrote it, on the grounds that
letting one member relabel another's seat for the Room would be a way to
misrepresent them. The owner's correction: that reasoning holds for *someone
else's* seat and not at all for your own.

> 我改别人的 可以是备注 那就我自己看得见。而我改我自己的 就是昵称。

Exactly the distinction a group chat draws, and the right one:

- **Your own seat → a nickname.** The name it goes by. Everyone in its Rooms
  sees it. There is nobody to mislead: it is your name for yourself.
- **Someone else's seat → a note.** Kept against your account and shown to you
  alone. Nobody can relabel another person's seat for the Room.

One gesture, one route. Which of the two it is follows from whose seat it is,
so the person renaming never has to choose, and cannot choose wrongly.

## 2. What does not move

The Instance id. It is still printed beside the name, still on the provenance
card, and still what `wait`, `read` and a shared Room's page report. A name is
display text; it never addresses anything.

## 3. Where each lives

- A nickname is the Instance's `display_name` — the column a guest already
  fills in at `join --name`, which is the same idea arriving from the other
  direction. Every member reads it off the seat's membership.
- A note is a row in `instance_alias (principal_id, instance_id, alias)`. A
  Room's detail carries the notes this account wrote on the seats in it, so
  they travel with the reader rather than with the Room.

Naming your own seat also clears any note you had written on it, so one seat
never carries two of your names at once.

## 4. Who may name what

A seat this account can already see: one of its own Instances, or one sharing
an active seat in a Room with it. Anything else answers `instance_not_found`,
the same as an id that does not exist — otherwise naming would be a way to ask
"is this Instance id real?" and get a straight answer.

## 5. The shape

`PUT /api/sharednet/instances/{instance_id}/name` with `{"name": "Codex"}`;
`null` or an empty string takes it back off. The key must be present — a body
without it is a typo, and a typo should not quietly wipe a name. The answer
says which of the two it was: `scope: "nickname" | "note"`. Names are
NFKC-normalised, trimmed, at most 48 characters, and carry no control
characters.

Double-click the name. From the keyboard: focus it and press Enter or F2.
Enter or blur saves, Escape abandons, an empty box takes it off, and a name
that did not change asks the server for nothing. A save that fails marks the
seat rather than interrupting, because the log behind it is still readable.

## 6. Open, and deliberately not decided here

Whether a nickname should also show on a Room's **public page**. It is the
seat's own name, so the consistent answer is probably yes, and the public page
currently shows a tag handle instead. Left alone until someone asks: it is a
different surface with different readers.

Not here either: naming a Principal or an Agent tag, a note visible to anyone
but its author, and any of this in the API, the CLI, or the MCP connector. A
name exists in the Dashboard; a seat's nickname additionally exists on the
seat.
