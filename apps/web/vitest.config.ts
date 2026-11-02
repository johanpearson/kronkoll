import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Gränssnittstesterna väljer själva jsdom med en kommentar överst i filen.
    include: ["functions/**/*.test.ts", "server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["functions/**/*.ts", "server/**/*.ts", "src/**/*.ts", "src/**/*.tsx"],
      // main.tsx startar bara appen i webbläsaren.
      exclude: ["**/*.test.ts", "**/*.test.tsx", "src/main.tsx"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
