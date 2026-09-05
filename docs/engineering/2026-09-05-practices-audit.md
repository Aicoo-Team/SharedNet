# Engineering practices audit — 2026-09-05

How the repository measures against the habits of well-run open-source
projects (React, Next.js, Kubernetes, Rust, PostgreSQL, Django, Supabase,
Tailscale, Deno), taken as a baseline rather than any single one of them.
Scores are as of commit `393404e`; the items marked *this PR* are addressed by
the change that adds this file.

| Practice | Baseline | SharedNet | Status |
| --- | --- | --- | --- |
| CI on every PR (typecheck, tests, build) | universal | none — `.github/` was empty | **this PR** |
| Real-database tests in CI | Django, Supabase, PostgreSQL | scripts existed, nothing ran them | **this PR** (service container) |
| Changes land through PRs with review | universal | 1 PR ever; 166 direct commits to `main` | policy in CONTRIBUTING; **enforcement needs branch protection**, which GitHub withholds from private repos on the free plan |
| Commit messages that explain why | Linux, Git, PostgreSQL | long-form, reasoned, conventional prefixes | **already strong** — keep it |
| Design docs and decision records | Rust RFCs, Kubernetes KEPs, ADRs | specs + plans + a decisions file | good; directory naming is tool-specific (`superpowers/`) |
| Strict typing | Deno, Next.js | `strict: true`, isolated modules | good; consider `noUncheckedIndexedAccess` |
| Linter and formatter | universal | none | **gap** — adopt Biome in one format-only PR with a `.git-blame-ignore-revs` (next) |
| Contributing guide | universal | none | **this PR** |
| Testing guide | Kubernetes, Rust | none | **this PR** |
| Security policy | universal | none | **this PR** |
| Code owners | most | none | **this PR** |
| PR template | most | none | **this PR** |
| Dependency updates | most | none | **this PR** (Dependabot, monthly, grouped) |
| Pinned toolchain | Next.js, Deno | `.nvmrc`, `packageManager`, `engines` | good |
| Secrets hygiene | universal | `.env*` ignored, `.env.example` documented, digests at rest | good |
| Readiness endpoint | Kubernetes | `/api/health` with a real query | good; now logs a redacted cause |
| Privacy promises tested | Tailscale | e2e asserts no local value is uploaded | **already strong** |
| Coverage reporting | React, Rust | none | **done 2026-09-05** — v8 report in CI, baseline 77.6% lines / 66.5% branches |
| Release notes / changelog | universal | none; deploy-on-push | acceptable for a hosted service; a deploy log would help |
| Lean tree | universal | Python tree, a git bundle, a skill's working directory and tool notes are tracked | **done 2026-09-05** — removed; see below |
| Browser automation | Next.js (Playwright) | manual | later |

## What to remove from the tree

Tracked, but not run by any script, not served by any deployment, and
confusing to a newcomer:

- `src/sharednet/{room,coordination,control}/*.py`, `tests/**/*.py`,
  `pyproject.toml`, `scripts/sharednet_entry.py`, `examples/` — the previous
  Python implementation. Two implementations in one tree means every reader
  has to work out which one is real.
- `sharednet-room-v1-recovery.bundle` — a 204 KB git bundle committed to the
  repository root.
- `.superpowers/` (17 files) and `.impeccable.md` — working directories of
  authoring tools.
- `SHAREDNET_ROOM_INVITE.md` in the root — an invitation mechanism that is now
  "know the Room id"; fold anything still true into the docs.

Removed on 2026-09-05 along with the `/downloads/sharednet-local` route that
only existed to serve the Python bundle; the history keeps them. The MIT
license that lived in `LICENSES/RAC-MIT.txt` is now the root `LICENSE`.

## Order of the remaining work

1. ~~Merge this PR~~ done; make CI a required check the moment the plan allows it.
2. Biome: one PR that adds the config and formats everything, plus
   `.git-blame-ignore-revs` pointing at that commit.
3. ~~The removal PR above~~ done.
4. `noUncheckedIndexedAccess`, fixing what it surfaces.
5. ~~Coverage report in CI~~ done; Playwright smoke of the Dashboard.
6. Point the Vercel **Preview** environment at a dev database — today it
   shares production's — then move migrations into the build command.
