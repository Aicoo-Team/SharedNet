const requiredEnvironment = [
  "BETTER_AUTH_DATABASE_PATH",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
];
const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
);

if (missingEnvironment.length > 0) {
  console.error(
    `Legacy SQLite auth migration requires: ${missingEnvironment.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  try {
    const [{ getMigrations }, { getAuth }] = await Promise.all([
      import("better-auth/db/migration"),
      import("../lib/auth.ts"),
    ]);
    const { runMigrations } = await getMigrations(getAuth().options);
    await runMigrations();
    console.log("Legacy SQLite auth migration completed.");
  } catch {
    console.error("Legacy SQLite auth migration failed.");
    process.exitCode = 1;
  }
}
