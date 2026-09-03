# SharedNet Local Stack and API Explorer Design

> **Status:** Approved in chat; awaiting written-spec review
>
> **Date:** 2026-09-03
>
> **Scope:** Reliable local Web/API startup, API compatibility detection, an authenticated read-only API Explorer, and full-stack acceptance coverage

## 1. Goal

Restore the account-scoped Network, Rooms, and Decisions surfaces on localhost and make the local stack difficult to start in a partially compatible state. Add a small operator-facing API Explorer that can issue the supported read-only browser requests and display their real JSON responses without exposing service credentials.

The finished local experience is:

```text
pnpm stack:dev
→ current SharedNet API starts against the selected durable database
→ current SharedNet Web starts with the same Console credential
→ readiness rejects a healthy-but-stale API binary
→ signed-in account sees live Network, Rooms, and Decisions
→ /api-explorer can issue allowlisted account-scoped reads
→ GET /v1 reports the API protocol version and capabilities
```

## 2. Root cause being fixed

The current failure is a version and configuration split, not data loss:

- the long-running Next development process hot-reloaded the new API-backed UI but lacks `SHAREDNET_API_URL` and `SHAREDNET_CONSOLE_TOKEN`;
- both running Room services predate the account Console endpoints required by the Web BFF;
- `/healthz` reports only process liveness, so it did not detect that protocol mismatch;
- the previously visible Network came from browser-local synthetic demo state, which was removed when the Dashboard switched to durable API projections;
- the selected durable database still contains Principal, Agent, Runtime, Room, and message records.

The fix must therefore restore one coherent runtime tuple—source version, database, API origin, Web origin, and shared Console credential—and must add a compatibility check stronger than health alone.

## 3. Non-goals

This work does not:

- restore the deleted synthetic Network or present fixtures as live activity;
- expose arbitrary HTTP requests, mutation endpoints, headers, cookies, or credentials in the browser;
- turn the Web application into a Room creation or Agent-message action plane;
- replace Better Auth, the existing account-scoped BFF routes, or the current projection contracts;
- expose FastAPI Swagger/ReDoc or the complete internal route table;
- make non-loopback development access the default;
- use the user's durable database as an automated-test fixture.

## 4. Architecture

### 4.1 Local stack contract

One repository command, `pnpm stack:dev`, owns the local API and Web child processes. It loads explicit local configuration, validates it before spawning either child, runs the idempotent Better Auth migration, starts the API from the current checkout, waits for protocol readiness, and then starts Next.

The launcher loads `.env.local` once, overlays explicitly exported process variables, and passes the resulting validated environment to both children. It requires `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_DATABASE_PATH`, `SHAREDNET_API_URL`, and `SHAREDNET_CONSOLE_TOKEN`; it does not invent or rotate either secret. The API database is exactly `BETTER_AUTH_DATABASE_PATH`, and the blob directory defaults to a sibling `blobs` directory unless `SHAREDNET_BLOB_PATH` is explicitly set. `SHAREDNET_API_URL` supplies the loopback API host and port. The current checkout's `.venv/bin/python` is the default interpreter; `SHAREDNET_PYTHON` may select another compatible interpreter while `PYTHONPATH` is still pinned to this checkout's `src` directory.

The stack uses:

- loopback hosts only;
- Web port `3001` by default;
- API port `8765` by default, with an explicit override for an already-owned port such as this machine's `8766`;
- one selected state directory containing the SQLite database and blobs;
- one stable Better Auth secret;
- one high-entropy Console credential shared only through the child-process environment;
- the current checkout's Python package, never a stale globally installed `sharednet` binary.

The launcher must fail before spawning on missing secrets, malformed origins, non-loopback hosts, mismatched database paths, unsupported Node/Python versions, or occupied ports that are not already owned by the exact compatible stack. It must never print secret values. Signals and normal termination must clean up only the exact child processes it started.

For the current recovery, the selected durable state is:

```text
database: /Users/wangxiang/.local/share/sharednet-runtime/webapp-v1/sharednet.db
blobs:    /Users/wangxiang/.local/share/sharednet-runtime/webapp-v1/blobs
web:      http://127.0.0.1:3001
api:      http://127.0.0.1:8766
```

Port `8765` remains a separate legacy local service and is not silently reused or terminated.

### 4.2 Protocol compatibility handshake

The SharedNet API adds an unauthenticated, non-sensitive `GET /v1` capability document. Its response is deliberately small and exact:

```json
{
  "api_version": "1",
  "capabilities": [
    "console.network.read.v1",
    "console.rooms.read.v1",
    "console.decisions.read.v1"
  ]
}
```

The document contains no route templates, tokens, credential state, database paths, package versions, host information, Principal identifiers, or account data. It proves protocol compatibility, not authorization or data readiness.

`stack:dev` considers the API ready only when both conditions hold:

1. `GET /healthz` returns the expected healthy response.
2. `GET /v1` passes strict schema and capability validation.

A live old binary that returns `404`, `401 invalid_runtime_token`, malformed JSON, or a different capability set fails readiness with a safe, actionable message.

### 4.3 Authenticated API Explorer

The Web application adds `/api-explorer` as a secondary Setup destination beside Protocol. It stays inside the authenticated Product Shell because every response is account-scoped.

The Explorer uses a compile-time allowlist of existing same-origin BFF reads:

| Label | Browser request | Input |
| --- | --- | --- |
| API capabilities | `GET /api/sharednet/status` | none |
| Network | `GET /api/sharednet/network` | none |
| Rooms | `GET /api/sharednet/rooms` | none |
| Room detail | `GET /api/sharednet/rooms/{room_id}` | exact Room ID |
| Decisions | `GET /api/sharednet/decisions` | none |

`/api/sharednet/status` proxies and strictly validates the non-sensitive backend `GET /v1` document. All other routes already derive the immutable Better Auth user ID server-side and attach the Console credential only between the BFF and SharedNet API.

The Explorer never accepts an arbitrary URL, HTTP method, query string, request body, or header. It never renders the backend Console path containing an account ID. It never stores responses in `localStorage`, session storage, cookies, or a response history.

### 4.4 Explorer interaction and visual design

The page is a quiet operator instrument, not a Postman clone and not a fake terminal:

- a narrow endpoint list on the left and a dominant response sheet on the right;
- stacked layout on narrow screens;
- the existing SharedNet product-shell typography, linework, Oxford/Atlantic/gold palette, focus treatment, and motion preferences;
- a short trust note: requests use the signed-in session and service credentials stay on the server;
- one `Send GET` action;
- Room detail exposes one validated Room ID field;
- the response header shows HTTP status, elapsed time, and completion time;
- JSON is escaped and pretty-printed inside a scrollable `<pre><code>` region;
- `Copy JSON` reports copied or failed state without silently persisting data.

Opening `/api-explorer` retains the Product Shell's existing idempotent account bootstrap behavior. The Explorer's own controls are read-only.

### 4.5 Request state and error handling

The client models one active request:

- untouched: prompt the operator to select a projection and send a request;
- invalid input: reject an empty or malformed Room ID before fetching;
- loading: disable duplicate submission and expose the active endpoint;
- success: preserve valid empty arrays/objects and render the exact safe BFF JSON;
- API failure: render the HTTP status and safe BFF `{error:{code,message}}` body;
- non-JSON failure: render a bounded diagnostic fallback without interpreting markup;
- superseded request: abort the old request and prevent its late result from replacing the current selection;
- unmount: abort the request and perform no state update;
- copy: provide accessible success/failure feedback.

The page must not convert an upstream failure into mock data.

## 5. Security and privacy invariants

- Browser JavaScript receives only account-scoped projection payloads and the non-sensitive capability document.
- Console, Connector, Runtime, Instance, Better Auth, and pairing credentials never enter HTML, JSON responses, URLs, screenshots, logs, test receipts, or command arguments.
- The BFF remains the only browser-to-Console bridge and derives `auth_user_id` from the authenticated session rather than request input.
- The API binds to loopback for local development.
- Local state directories use mode `0700`; databases, backups, and secret-bearing environment files use mode `0600`.
- Database backup uses SQLite's online backup/checkpoint semantics rather than copying a live database file without its WAL.
- Automated E2E uses generated secrets and a fresh temporary state directory.
- Error responses preserve existing safe codes and scrub upstream/internal details.

## 6. Data and migration behavior

Before the current durable database is opened by the upgraded API:

1. verify the exact selected database path;
2. create a SQLite-consistent backup with owner-only permissions;
3. run `PRAGMA quick_check` on the backup and source;
4. run the existing idempotent Better Auth migration;
5. let the current API store initialization apply additive schema changes;
6. provision the signed-in account and run the existing transactional, idempotent demo seed for `xisen.demo@sharednet.local`;
7. verify existing Room/message counts did not decrease.

The seed may add the approved offline demo profiles and account mapping. It must not invent live Runtime leases, messages, costs, provider activity, or execution evidence.

## 7. Permanent full-stack acceptance test

Add an opt-in `pnpm e2e:sharednet` harness that owns an isolated temporary stack:

1. allocate fresh loopback ports and a fresh temporary state directory;
2. generate in-memory Better Auth and Console secrets;
3. migrate Better Auth;
4. start the current API and require both health and `/v1` compatibility;
5. start a production-built or dedicated E2E Next server;
6. create and sign in a Better Auth user through the public auth API;
7. hold the session cookie in memory only;
8. seed the demo account through the guarded Console path;
9. call BFF bootstrap, Network, Rooms, Room detail, and Decisions;
10. create two local Agents, connect Runtime/Instance identities, build/join a Room, exchange messages, and request/resolve a Decision;
11. prove a second account cannot read the first account's projections;
12. restart API and Web and prove durable state remains while lease-derived presence behaves correctly;
13. terminate only owned children and emit a secret-free receipt.

The harness fails on stale API capability responses, secret leakage, orphaned children, malformed projection payloads, lost durable rows, or cross-account visibility.

Existing focused suites remain required:

- Python API/store/Room/Decision tests;
- Better Auth migration and integration tests;
- server-client and BFF route contract tests;
- SharedNet Provider concurrency/abort tests;
- API Explorer component and navigation tests;
- typecheck and production build;
- browser verification of `/network` and `/api-explorer` against the recovered durable local stack.

## 8. Code organization

The implementation should keep responsibilities narrow:

- `scripts/dev-stack.mjs` — local process orchestration and readiness only;
- `scripts/e2e-sharednet-v1.mjs` — isolated full-stack acceptance orchestration;
- `src/sharednet/api-capabilities.ts` — strict capability constants and validation;
- `src/sharednet/read-endpoints.ts` — browser-safe Explorer allowlist and path construction;
- `src/components/api-explorer-view.tsx` — Explorer interaction and rendering;
- `app/api-explorer/page.tsx` — route metadata and component composition;
- `app/api/sharednet/status/route.ts` — authenticated BFF proxy for capabilities;
- `src/sharednet/room/api.py` — backend `GET /v1` capability response;
- focused tests adjacent to existing auth, route, component, and Python suites.

No unrelated refactor is included. Existing BFF projection routes and public `/protocol` behavior remain unchanged.

## 9. Rollout and recovery acceptance

The live repair is complete only when all of the following are true:

- a SQLite-consistent backup exists and passes `quick_check`;
- the selected database is served by the current checkout on `127.0.0.1:8766`;
- `/healthz` and `/v1` both pass;
- the Web process was restarted with the same Console credential and `SHAREDNET_API_URL=http://127.0.0.1:8766`;
- the demo account signs in without changing its password;
- `/network` renders a real account-scoped graph and no unavailable state;
- `/api-explorer` successfully displays capabilities, Network, Rooms, Room detail, and Decisions;
- existing durable Room/message counts are preserved;
- the permanent full-stack E2E, focused tests, typecheck, and production build pass;
- no secret appears in logs, receipts, browser-visible payloads, or committed files.

If any migration or readiness check fails, stop the new stack, preserve the backup and original durable state, and report the exact safe error. Do not fall back to synthetic data or silently switch databases.
