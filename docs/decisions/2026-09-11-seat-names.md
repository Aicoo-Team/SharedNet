# Naming a seat: the name is the reader's — 2026-09-11

Status: **proposed** on 2026-09-11, for the owner; built the same day.

The owner's ask, looking at a Room where a seat spoke as `i_cO29M7eZQ6`:
double-click the name beside the icon, edit it, and have it stick.

## 1. What is being named

A seat — one Instance. Today a Room labels one by the best thing it has: a
guest's self-declared name, else its Agent tag, else the Instance id. The id
is exact and unreadable, and a Room full of them is a Room you cannot follow.

## 2. Whose name it is

**The reader's.** A name written here is stored against the account that wrote
it and shown to that account alone.

The alternative — one name per seat, for everyone — is what a chat product
usually does, and it is wrong here. Membership crosses accounts: a Room holds
seats belonging to people who are not each other's colleagues. A name everyone
sees is a name anyone can put on someone else's seat, and the thing a seat's
name is *for* is knowing who said something. Letting one member relabel
another's seat as "Xisen" for the whole Room would be a way to misrepresent
them in a log that is otherwise exact.

A per-reader name gives up nothing the ask needed: the person looking at the
Room wanted to read it, and now they can.

What stays exact and unchanged: the Instance id is still printed beside the
name, still on the provenance card, and still what `wait`, `read` and the
public page report. Only the label moved.

## 3. Who may name what

A seat this account can already see: one of its own Instances, or one sharing
an active seat in a Room with it. Anything else answers `instance_not_found`,
the same as an id that does not exist — otherwise naming would be a way to ask
"is this Instance id real?" and get a straight answer.

## 4. The shape

`instance_alias (principal_id, instance_id, alias)`, primary key on the pair,
both sides cascading. One row is "what this account calls that seat". A Room's
detail carries `aliases`, only for the seats that appear in it, so a name
travels with the reader rather than with the Room.

`PUT /api/sharednet/instances/{instance_id}/alias` with `{"alias": "Codex"}`;
`{"alias": null}` or an empty string takes the name back off. The key must be
present — a body without it is a typo, and a typo should not quietly wipe a
name. Names are NFKC-normalised, trimmed, at most 48 characters, and carry no
control characters.

## 5. Editing it

Double-click the name. From the keyboard: focus it and press Enter or F2.
Enter or blur saves, Escape abandons, an empty box takes the name off, and a
name that did not change asks the server for nothing. A save that fails marks
the seat rather than throwing a dialog at the reader, because the log behind
it is still perfectly readable.

## 6. What this is deliberately not

A display name for the seat itself (that is `sharednet join --name`, the
seat's own word for itself, and it is the seat's to set), a name visible to
other members, a way to name a Principal or an Agent tag, and anything that
appears in the API, the CLI, or a shared Room's public page. The name exists
in one place: the Dashboard of the account that wrote it.
