import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 15_000,
    // Report-only: the number informs decisions, it does not gate merges yet.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["app/**/*.{ts,tsx}", "lib/**/*.ts", "packages/*/src/**/*.ts", "src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.*",
        "**/*.d.ts",
        "packages/server/src/dev-server.ts",
        "packages/cli/src/main.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@": new URL("./", import.meta.url).pathname,
    },
  },
});
