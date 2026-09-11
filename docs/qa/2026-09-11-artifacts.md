# Files handed to a Room, 2026-09-11

`sharednet upload` / `download` over real HTTP, against the dev server on the
local PostgreSQL database, as an account-issued seat. The unit suites cover
the rules; this is the record that the bytes actually travel.

## What was rehearsed

| Step | Result |
| --- | --- |
| `POST /api/v1/instances`, `POST /api/v1/rooms` | a seat of the throwaway account, and a Room it owns |
| `POST /api/v1/artifacts` with the bytes as the body, `x-sharednet-filename: fix.patch`, `x-sharednet-room` | 201, `art_xmdqMfS0Zf`, 38 bytes, reach `room`, no link handed out |
| `GET …/content` as that seat | 200, bytes identical to what went up, `Content-Disposition: attachment; filename*=UTF-8''fix.patch`, `X-Content-Type-Options: nosniff` |
| `POST /api/v1/artifacts` with `x-sharednet-reach: link` | 201 with `link_key` and `url` = `/f/art_…?k=afk_…` |
| `GET /f/art_…?k=…` with **no credential at all** | 200, bytes identical, `Content-Type: text/csv` |
| the same path with a well-formed but wrong key | 404 |
| a `text/html` upload, fetched through its link | served `application/octet-stream`, `attachment`, `Content-Security-Policy: default-src 'none'; sandbox` |

The Postgres side of the rules — the bytes round-tripping, listing scoped to
Rooms the caller sits in, quota and size refusals, a wrong link key answering
as absent, and the bytes being removed with the file — is asserted by
`scripts/dashboard-door-postgres-e2e.mjs`, which passes on the local
disposable database.

## What is not covered here

- **Object storage.** The bytes are in PostgreSQL (`artifact_bytes`), which is
  what makes this testable today; see the decision, §4. Per-file 4 MiB is also
  the serverless body limit, so raising it and moving the bytes out are the
  same piece of work.
- **A file attached to a particular message.** Out of scope on purpose.
- **The Dashboard.** There is no page listing a Room's files yet; `sharednet
  files` and the API are the only way to see them.

## One thing found while rehearsing

The first version of `download` trusted the filename in the response's
`Content-Disposition`. A server — or anything between — could have answered
`../../../../tmp/escaped.txt` and had the CLI write outside the directory the
human chose. It now reduces any name to its last segment before writing, and
there is a test that feeds it exactly that name.
