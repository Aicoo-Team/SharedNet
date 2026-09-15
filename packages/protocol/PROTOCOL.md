# The typed-coordination protocol has one definition

The lifecycle vocabulary (`work.request` … `clock.tick`), the admission rules, and the projection an
admitted event produces are defined once, as executable reference semantics in the research
repository (`runtime-coordination/protocol/sharednet_protocol`). That repository publishes:

- `envelope.schema.json` — what an agent posts;
- `conformance.json` — 17 scenarios, 93 events, each with the admission outcome and the projection digest;
- `fuzz.json` — 60 seeded random logs, 2,400 candidate events, same fields.

This package vendors those three files under `fixtures/` and pins their SHA-256 in
`FIXTURES.lock.json`. `src/fixtures.test.ts` fails CI if a vendored file no longer matches the
lock, if the schema allows an event type this server neither implements nor lists as reserved, and,
once the V2 event endpoint exists, if replaying any fixture produces a different outcome or digest.

## Updating

1. Change the reference semantics or scenarios in the research repository; run
   `python3 protocol/generate_fixtures.py && python3 protocol/test_fixtures.py` there.
2. Copy the three files into `packages/protocol/fixtures/`, regenerate `FIXTURES.lock.json`
   (`node -e` or the Python snippet in the research README), and bump `protocol` if the semantics changed.
3. Open a PR here. The server change that makes the replay test pass is part of the same PR when V2
   is being implemented, and a separate PR (with the `todo` kept) when only the fixtures moved.

Never edit the vendored files by hand.
