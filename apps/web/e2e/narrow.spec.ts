// Smal mobil (350 px) med sexsiffriga belopp: ingen text får gå utanför sina rutor. Fel som ägaren såg
// 2026-11-04 i Översikt (Saldo / In / Ut) och Budget (Budget / Utfall / Kvar).
import { expect, test } from "@playwright/test";
import { useFakeApi } from "./fake-api.ts";

test.use({ viewport: { width: 350, height: 780 } });

for (const path of ["/", "/budget"]) {
  test(`${path} får plats på 350 px med sexsiffriga belopp (KK-25)`, async ({ page }) => {
    await useFakeApi(page, { scale: 10 });
    await page.goto(path);
    const stats = page.locator("dl.stats");
    await expect(stats).toContainText(/\d{3}\s\d{3},\d{2}\skr/u);

    const outside = await stats.evaluate((dl) => {
      const box = dl.getBoundingClientRect();
      return [...dl.querySelectorAll("dt, dd")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < box.left || r.right > box.right || el.scrollWidth > el.clientWidth;
        })
        .map((el) => el.textContent);
    });
    expect(outside).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(350);
  });
}
