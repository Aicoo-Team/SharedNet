<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working in this repository

Read `CONTRIBUTING.md` (how changes get in: branch, PR, green CI, a commit
body that says why) and `docs/TESTING.md` (what each kind of change must
prove) before editing. Decisions about identity, membership and grouping live
in `docs/decisions/`; the normative design is under `docs/superpowers/specs/`.
Never commit to `main` directly, never commit a token or a `.env*` file, and
never make a stubbed network call the only evidence that a server route exists.
