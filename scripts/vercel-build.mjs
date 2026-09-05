#!/usr/bin/env node
// Vercel build entry.
//
// A production build applies migrations first, so a migration that fails
// fails the build and nothing deploys ahead of the schema — the "migrate
// before merging" rule, automated. A preview build never touches the
// database: there is exactly one, and it is production's
// (docs/decisions/2026-09-05-one-database-for-now.md). A preview whose code
// expects a migration that has not run will show errors, which is the honest
// outcome, rather than mutating the real database from a branch.
import { spawnSync } from "node:child_process";

const environment = process.env.VERCEL_ENV ?? "development";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (environment === "production") {
  console.log("[build] production: applying migrations before the build");
  run("pnpm", ["run", "db:migrate"]);
} else {
  console.log(`[build] ${environment}: not migrating — previews never touch the shared database`);
}
run("pnpm", ["run", "build"]);
