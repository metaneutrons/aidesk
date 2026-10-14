import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    globalSetup: ["tests/global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts", "src/server/**/*.ts", "src/server/**/*.tsx"],
      // The entry of the process that reads files runs in a process of its own;
      // the tests of the sandbox exercise it, which this coverage cannot see.
      exclude: ["src/server/extract/child.ts", "**/*.d.ts"],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
      reporter: ["text", "json-summary", "lcov"],
    },
  },
});
