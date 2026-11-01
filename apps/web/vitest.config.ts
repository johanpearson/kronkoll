import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["functions/**/*.test.ts", "server/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["functions/**/*.ts", "server/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
