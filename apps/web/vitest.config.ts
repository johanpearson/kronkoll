import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Gränssnittstesterna väljer själva jsdom med en kommentar överst i filen.
    include: ["functions/**/*.test.ts", "server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    // Kontrasttestet läser tokens.css som text. Utan detta ger vitest en tom sträng för CSS.
    css: { include: [/tokens\.css/u] },
    coverage: {
      provider: "v8",
      include: ["functions/**/*.ts", "server/**/*.ts", "src/**/*.ts", "src/**/*.tsx"],
      // main.tsx och sw.ts startar bara appen och service workern i webbläsaren; logiken testas i shell.ts.
      exclude: ["**/*.test.ts", "**/*.test.tsx", "src/main.tsx", "src/sw/sw.ts"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
