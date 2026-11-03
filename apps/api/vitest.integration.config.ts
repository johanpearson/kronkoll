// Integrationstester (KK-16): den riktiga workern körs i workerd med en lokal D1 utan persistens,
// migrerad med samma filer som `wrangler d1 migrations apply`. Inget anrop lämnar maskinen.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Relativt paketet: skriptet körs alltid från apps/api.
const migrations = await readD1Migrations("../../packages/adapter-d1/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Påhittade värden som ersätter produktionens (KK-13-B). Bankhemligheterna saknas med flit.
        bindings: {
          ACCESS_TEAM_DOMAIN: "https://kronkoll-test.cloudflareaccess.com",
          APP_ORIGIN: "https://kronkoll-25e.pages.dev",
          ACCESS_AUD: "aud-tag-test",
          ACCESS_ALLOWED_EMAILS: "johan@example.se",
          TEST_MIGRATIONS: migrations,
        },
        d1Databases: { DB: "kronkoll-integration" },
        d1Persist: false,
      },
    }),
  ],
  test: {
    include: ["integration/**/*.test.ts"],
    setupFiles: ["./integration/apply-migrations.ts"],
  },
});
