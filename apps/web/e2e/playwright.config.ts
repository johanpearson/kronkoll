// E2E av de kritiska flödena (KK-15-B). Produktionsbygget körs i Pages lokala runtime, så att
// _headers och CSP gäller som i drift. /api/* svarar ett påhittat API i testerna (fake-api.ts):
// Access och banken går inte att nå lokalt. Bara Chromium i mobil viewport (R-7).
import { defineConfig, devices } from "@playwright/test";

const PORT = 8788;
const CI = process.env["CI"] !== undefined;

export default defineConfig({
  testDir: ".",
  outputDir: "../test-results",
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["github"], ["html", { outputFolder: "../playwright-report", open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    trace: "retain-on-failure",
    // Service workern hanterar /api/overview, och sidans påhittade API (page.route) ser inte dess
    // anrop. Den är därför avstängd i alla tester utom pwa.spec.ts, som slår på den själv.
    serviceWorkers: "block",
  },
  projects: [{ name: "mobil", use: { ...devices["Pixel 7"] } }],
  webServer: {
    command: "pnpm preview",
    cwd: "..",
    url: `http://127.0.0.1:${String(PORT)}/`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
