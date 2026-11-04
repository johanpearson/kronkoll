// Tillgänglighet i mobil viewport (KK-26, V-e2e-a11y): axe på huvudvyerna i ljust och mörkt läge,
// som systemet ställer in dem, och att animationerna är korta och stängs av vid minskad rörelse.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { useFakeApi } from "./fake-api.ts";

const VIEWS = ["/", "/transaktioner", "/budget", "/sparmal", "/sparmal/nytt", "/installningar", "/installningar/kategorier", "/installningar/regler"];

/** Längsta övergång eller animation på sidans knappar och länkar, i millisekunder. */
function longestMotionMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ms = (value: string) => Math.max(...value.split(",").map((v) => parseFloat(v) * (v.trim().endsWith("ms") ? 1 : 1000)));
    const elements = [...document.querySelectorAll("button, a")];
    return Math.max(0, ...elements.map((e) => getComputedStyle(e)).map((s) => Math.max(ms(s.transitionDuration), ms(s.animationDuration))));
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const path of VIEWS) {
    test(`${path} har inga WCAG AA-fel i ${colorScheme === "light" ? "ljust" : "mörkt"} läge (KK-26-A)`, async ({ page }) => {
      await useFakeApi(page);
      await page.emulateMedia({ colorScheme });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText("Laddar")).toHaveCount(0);
      // Vyn ska visa innehåll från det påhittade API:t, inte ett felmeddelande.
      await expect(page.getByRole("alert")).toHaveCount(0);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });
  }
}

test("animationerna är högst 250 ms och stängs av vid minskad rörelse (KK-26-B)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Översikt" })).toBeVisible();
  const normal = await longestMotionMs(page);
  expect(normal).toBeGreaterThan(0);
  expect(normal).toBeLessThanOrEqual(250);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await longestMotionMs(page)).toBe(0);
});
