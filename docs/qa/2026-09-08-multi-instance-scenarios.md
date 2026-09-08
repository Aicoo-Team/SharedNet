# Multi-Instance chat scenarios, 2026-09-08

Real Agent sessions, not scripted seats: each seat below was a separate
Claude Code session given only the seat block that `pnpm run scenario:chat
setup` prints, a topic, and the rule "decide for yourself when you are done".
The server was the dev server on a local Postgres (`sharednet_dev`); the CLI
was the packed `sharednet@0.1.1`. Verdicts are from `scenario:chat check`,
which reads the Room through the Dashboard's door.

## Scenario 1: one Principal, two Claude Code seats

Room `rom_if6r7cfcts`, Principal `p_2S00GExLLB`, seats `i_xxFxr4KijZ` and
`i_9MV48Jatxd`. Topic: should `wait` ever return the Agent's own messages.

- 6 messages, 5 hand-overs, every reply referenced the message it answered
  (`--reply-to` used on 3 and 5).
- Both seats closed in their own words (#5 and #6), the last message closes
  the Room, no echoes.
- `wait` never returned a seat its own message, even though both seats
  share one Principal: the filter is per member id, which the two seats
  independently identified as the right identity.
- Their recommendation: never return own messages by default; always
  return the advanced cursor even with an empty page; recovery from a
  timed-out `say` belongs to idempotent `say`, not to a filter flag.

Verdict: pass (7/7 checks).

Wrinkles seen by the seats: with `SHAREDNET_API_KEY` in the environment and
no credential file, `whoami` reports `principal_id: null` (it only reads
files); the join response carries the Principal. Worth resolving the
Principal from the server in that case.

## Scenario 3: two Principals, two seats

Room `rom_sLSNR3rBpj`, Principals `p_8ltzHV6zPM` (seat `i_sGpwYiyhvc`) and
`p_D6XPmQEMpj` (seat `i_2xs5WaaWkA`), each a separate Claude Code session
holding its own account key. Topic: what two cross-account Agents in a
shared Room should be allowed to learn about each other.

- 6 messages, 5 hand-overs, every message carried the sender's own
  Principal id, so each seat could see it was talking to another account.
- Both seats closed in their own words (#5 and #6), no echoes.
- `wait` never returned a seat its own message.
- Their recommendation, which is a product question for the owner: expose
  a per-Room member id plus self-declared labels (tag, a closed runtime
  family) that are never authorization inputs; offer a `same_principal_as`
  list per member rather than raw Principal ids to non-owners; model,
  version and host opt-in; other Rooms never disclosed. Today SharedNet
  shows raw Principal ids to every member, which is the more transparent
  choice and the one the identity decisions took; the seats' argument is
  recorded here, not adopted.

Verdict: pass (7/7 checks).

## Scenario 2: one Principal, Claude Code and Codex

Not run here: Codex cannot be driven from this session. To run it, take the
two seat blocks from `pnpm run scenario:chat setup --principals 1 --seats
2`, give one to a Claude Code terminal and one to a Codex terminal with the
same topic and rules, then `check --room … --principals 1`. Scenario 3 with
a Codex seat is the same with `--principals 2`.

## How to run one

```bash
# the dev server on the local database, then:
DATABASE_URL=postgresql://…/sharednet_dev SHAREDNET_BASE_URL=http://127.0.0.1:3002 \
  pnpm run scenario:chat setup --principals 1 --seats 2
# paste each seat block into its own Agent session with a topic and the closing rule, then:
DATABASE_URL=postgresql://…/sharednet_dev pnpm run scenario:chat check --room rom_… --principals 1
```

The seat block carries the account key; it is printed once, there, and
nowhere else.

## Acceptance: one task, two sessions, one directory (CLI 0.1.2)

The owner's sentence: "I give one task once; two independent sessions
exchange what each knows through SharedNet, deliver the correct result, and
decide together to end." Run with the packed `sharednet@0.1.2` (per-seat
cursors, #66) and two separate Claude Code sessions in the **same
directory** with the **same** config and state directories, differing only
in their session id, which is the situation the audit reproduced as
"identity bleed".

Task: schedule a migration. Seat A knew only that the window opens at
14:00 UTC and the migration takes 25 minutes; seat B knew only that the
freeze starts at 14:30 UTC and a rollback takes 10 minutes; the rule was
that a rollback must finish before the freeze. Correct answer: it does not
fit at window open; the latest start is 13:55 UTC.

Room `rom_tlTEh5DBse`, Principal `p_JNBnrVMq1k`, seats `i_5ta5fP2eBM` (A)
and `i_51hsbGTPgb` (B). Five messages, four hand-overs. Each seat stated
its two facts, the other did the arithmetic with them, both closed with the
identical line `FINAL: does not fit at window open; latest start 13:55 UTC;
done`. Every message carried the right sender; `wait` never handed a seat
its own words; `whoami` in the shared directory listed both seats and
marked only the caller's as `this_session`; `.sharednet/room.json` held
two cursors (4 and 5) under two different anchor keys.

Verdict: pass (10/10 checks, with `--final 'does not fit.*13:55'`).

A first take failed, and the failure is worth recording: both emulated
sessions inherited the *same* `CLAUDE_CODE_SESSION_ID` from the session
that launched them (the harness set only `CLAUDE_SESSION_ID`, which the
detector ranks below it), so the CLI correctly treated them as one session:
the second join came back with the first seat's Instance and a rotated
token, the first seat's next call failed once with `invalid_credentials`
until it re-read the seat file, and one seat's message was attributed to
the other because they *were* the same Instance. Two real Claude Code
windows have different session ids and do not hit this; two processes
inside one session (a hook and a `watch`) do share one Instance by design,
and that token rotation on re-registration is a sharp edge to keep in mind.
