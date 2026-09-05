# One database for now — 2026-09-05

**Decision.** SharedNet runs against a single PostgreSQL database — the
production one on Supabase — for every environment: production, Vercel
previews, and local development that points at the hosted service. There is
no dev database yet, deliberately.

**Why.** The project is days old, has one maintainer, and holds only seed
and smoke data. A second database today would be a second thing to keep
migrated, a second set of credentials to rotate, and a second place for a
discrepancy to hide, in exchange for protecting data that does not yet exist.
The rule is to add the protection when there is something to protect.

**What follows from it.**

- **Previews never migrate.** Vercel's build command is
  `pnpm run build:vercel` (`vercel.json`), which applies migrations only when
  `VERCEL_ENV=production`. A preview whose code expects a migration that has
  not run will show errors; that is the honest outcome, and better than a
  branch mutating the real database.
- **Production migrates inside its build**, before the new code goes live.
  A failed migration fails the build; nothing deploys ahead of the schema.
  The manual "migrate first, merge second" rule is retired. The migrator
  holds a PostgreSQL advisory lock, so two concurrent production builds
  cannot run migrations over each other.
- **Breaking migrations still need care.** Between the migration and the new
  code going live, the old code serves against the new schema for roughly a
  minute. Additive changes do not notice. A breaking change (a column
  dropped, a constraint tightened) needs the expand/contract pattern —
  additive first, code that tolerates both, then the contraction in a later
  release — or an accepted minute of errors, stated in the PR.
- **CI proves migrations on a disposable database**, never the real one: the
  `postgres` job applies every migration to an empty PostgreSQL 16 container
  and runs the end-to-end harness there. The harness drops and recreates the
  SharedNet schemas, which is exactly why it must never see production; its
  name guard (`test` or `e2e` in the database name) enforces that.
- **The real database is checked by the smoke, as a fixed account.**
  `scripts/smoke-production.mjs` runs after every successful production
  deployment, once a day, and on demand (`.github/workflows/smoke.yml`) as
  `smoke-ci@sharednet.ai`, whose password and API key live only in GitHub
  Actions secrets. It creates Instances, reuses one tag, and opens one Room
  per run. There is no password reset flow; if the secrets are lost, create
  a new account and replace the secrets.
- **Local development** uses a local PostgreSQL (see the memory of how it is
  set up) or the hosted database through `.env.local`; nothing in the test
  tree ever reads `.env.local`.

**When to revisit — and what the hand-over looks like.** Add a dev database
when any of these becomes true: a second person is making schema changes; a
breaking migration is coming that expand/contract cannot cover; the database
holds data someone would mind losing. The work, for whoever takes it over
(Chenyu's team):

1. Create a second Supabase project (or a Neon branch, or Supabase
   branching if the plan allows) as `sharednet-dev`.
2. Point the Vercel **Preview** environment's `SHAREDNET_POSTGRES_URL` and
   `SHAREDNET_POSTGRES_URL_NON_POOLING` at it, with `uselibpqcompat=true`;
   leave Production untouched.
3. In `scripts/vercel-build.mjs`, let preview builds migrate too — the
   environment check becomes `production || preview`. Previews then run their
   own migrations against the dev database and stop showing schema errors.
4. Optionally point `.env.local` at the dev database by default and reserve
   the production URLs for operations.

None of that changes the schema, the code, or the CI jobs; it is
configuration plus one line in the build script.
