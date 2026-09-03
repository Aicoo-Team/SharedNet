import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./packages/db/src/auth-schema.ts", "./packages/db/src/schema.ts"],
  out: "./packages/db/migrations",
  schemaFilter: ["sharednet_auth", "sharednet"],
  strict: true,
  verbose: true,
});
