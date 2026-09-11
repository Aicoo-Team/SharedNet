/**
 * Mints a credit grant code (decision 2026-09-11) on the database named by
 * DATABASE_URL_UNPOOLED, through the repository's operator door. Nothing else
 * can create a code: no route, no page. The code is never written to the
 * repository or to a .env file; say it out loud to the people it is for.
 *
 *   DATABASE_URL_UNPOOLED=postgresql://… node --experimental-strip-types scripts/credits/mint-code.mjs \
 *     --code HACK-2026 --amount 100 [--max 200] [--expires 2026-10-01T00:00:00Z]
 */
import pg from "pg";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const url = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
const code = option("code")?.trim().toUpperCase();
const amount = Number(option("amount"));
const max = option("max") === undefined ? null : Number(option("max"));
const expires = option("expires") ?? null;

if (!url) {
  console.error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is required.");
  process.exit(1);
}
if (!code || !/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(code)) {
  console.error("--code must be 3 to 32 letters, digits or dashes (stored upper-case).");
  process.exit(1);
}
if (!Number.isSafeInteger(amount) || amount < 1) {
  console.error("--amount must be a whole number of credits, at least 1.");
  process.exit(1);
}
if (max !== null && (!Number.isSafeInteger(max) || max < 1)) {
  console.error("--max must be a whole number, at least 1, or omitted for no cap.");
  process.exit(1);
}
if (expires !== null && Number.isNaN(Date.parse(expires))) {
  console.error("--expires must be an ISO timestamp, or omitted for no expiry.");
  process.exit(1);
}

process.env.DATABASE_URL = url;
process.env.DATABASE_URL_UNPOOLED = url;
const { createDatabase } = await import("../../packages/db/src/client.ts");
const { PostgresSharedNetRepository } = await import("../../packages/server/src/postgres-repository.ts");

const pool = new pg.Pool({ connectionString: url });
try {
  const repository = new PostgresSharedNetRepository(createDatabase(pool));
  const minted = await repository.mintCreditCode({ code, amount, max_redemptions: max, expires_at: expires });
  console.log(JSON.stringify(minted.code));
} finally {
  await pool.end();
}
