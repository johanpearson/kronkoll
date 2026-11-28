// Bakåtknappen som i en app (KK-62, #245): flikbyten lägger inte till steg, undervyer går tillbaka dit de
// öppnades från, och bakåt från Översikt lämnar appen. page.goBack() gör det som telefonens bakåtknapp gör.
import { expect, test, type Page } from "@playwright/test";
import { useFakeApi } from "./fake-api.ts";

const tab = (page: Page, name: string) => page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("link", { name });

test("flikbyten lägger inte till steg: bakåt går till Översikt och sedan ut ur appen (KK-62-A, C, D)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Översikt" })).toBeVisible();
  for (const name of ["Budget", "Lån", "Inkomst"]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Översikt" })).toBeVisible();
  // Översikt är appens enda steg, så nästa bakåt lämnar den (i en installerad PWA stängs appen).
  await page.goBack();
  expect(page.url()).toBe("about:blank");
});

test("bakåt från en undervy går till vyn den öppnades från (KK-62-B)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/");
  await tab(page, "Inkomst").click();
  await page.getByRole("button", { name: "Visa det som räknas i oktober 2026" }).click();
  await page.getByRole("list", { name: "Inbetalningar Oktober 2026" }).getByRole("listitem").first().getByRole("link").click();
  await expect(page).toHaveURL(/\/transaktioner\/lon1$/u);
  await page.goBack();
  await expect(page).toHaveURL(/\/inkomst$/u);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/u);
});

test("en djuplänk får samma steg bakåt som om man gått dit (KK-62-G)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/installningar/regler");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/installningar$/u);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/u);
  await page.goBack();
  expect(page.url()).toBe("about:blank");
});

test("en flik öppnas där man senast var i den, och ett tryck till går till flikens start (KK-62-F)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/");
  await tab(page, "Inkomst").click();
  await page.getByRole("button", { name: "Visa det som räknas i oktober 2026" }).click();
  await page.getByRole("list", { name: "Inbetalningar Oktober 2026" }).getByRole("listitem").first().getByRole("link").click();
  await expect(page).toHaveURL(/\/transaktioner\/lon1$/u);
  await tab(page, "Budget").click();
  await expect(page).toHaveURL(/\/budget$/u);
  await tab(page, "Inkomst").click();
  await expect(page).toHaveURL(/\/transaktioner\/lon1$/u);
  await tab(page, "Inkomst").click();
  await expect(page).toHaveURL(/\/inkomst$/u);
});

test("undervyer har en synlig tillbakaknapp, eftersom iOS saknar bakåtknapp (KK-62-B, H)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/installningar/regler");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Tillbaka" }).getByRole("button", { name: "Tillbaka" }).click();
  await expect(page).toHaveURL(/\/installningar$/u);
  await page.getByRole("button", { name: "Tillbaka" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("button", { name: "Tillbaka" })).toHaveCount(0);
});

/**
 * Ett finger som drar över skärmen, genom webbläsarens riktiga gesthantering (touch-action, scrollning och
 * pointercancel) via Chromes CDP. Syntetiska händelser direkt på elementet går förbi den, och då syns inte
 * fel som att webbläsaren tar över ett lodrätt drag (#247).
 */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(...from) });
  for (let i = 1; i <= steps; i += 1) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x, y) });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("ett svep i sidled byter flik i menyns ordning, utan nytt steg bakåt (KK-63-A, C)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/budget");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await drag(page, [330, 400], [60, 405]);
  await expect(page).toHaveURL(/\/lan$/u);
  await expect(tab(page, "Lån")).toHaveAttribute("aria-current", "page");
  await drag(page, [60, 400], [330, 405]);
  await expect(page).toHaveURL(/\/budget$/u);
  // Svepen lade inte till steg: bakåt går till Översikt.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/u);
  // Översikt har också dra för att synka, men ett svep i sidled byter ändå flik.
  await expect(page.getByRole("heading", { level: 1, name: "Översikt" })).toBeVisible();
  await drag(page, [330, 400], [60, 410]);
  await expect(page).toHaveURL(/\/transaktioner$/u);
});

test("dra nedåt högst upp i Översikt startar en synk, som syns i synkikonen (KK-63-D)", async ({ page }) => {
  await useFakeApi(page);
  const syncs: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/sync") syncs.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Översikt" })).toBeVisible();
  await drag(page, [200, 200], [200, 520]);
  await expect.poll(() => syncs.length).toBe(1);
  await expect(page.locator(".ui-pull")).toHaveCount(0);
  // Ett kort drag synkar inte.
  await drag(page, [200, 200], [200, 260]);
  await page.waitForTimeout(300);
  expect(syncs).toHaveLength(1);
});
