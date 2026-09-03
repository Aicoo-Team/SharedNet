const migrationUrl =
  process.env.DATABASE_URL_UNPOOLED?.trim() ||
  process.env.SHAREDNET_POSTGRES_URL_NON_POOLING?.trim();

if (!migrationUrl) {
  console.error(
    "SharedNet migrations require DATABASE_URL_UNPOOLED or SHAREDNET_POSTGRES_URL_NON_POOLING.",
  );
  process.exitCode = 1;
} else {
  try {
    const { migrateDatabase } = await import("../packages/db/src/migrate.ts");
    await migrateDatabase({ connectionString: migrationUrl });
    console.log("SharedNet checked database migrations completed.");
  } catch {
    console.error("SharedNet database migration failed.");
    process.exitCode = 1;
  }
}
