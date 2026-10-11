import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts", "src/server/**/*.ts", "src/server/**/*.tsx"],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
      reporter: ["text", "json-summary", "lcov"],
    },
  },
});
