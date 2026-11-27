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

test("ett svep i sidled byter flik i menyns ordning, utan nytt steg bakåt (KK-63-A, C)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/budget");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const view = page.locator(".ui-view");
  const swipe = async (from: number, to: number) => {
    const init = { pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true, clientY: 400 };
    await view.dispatchEvent("pointerdown", { ...init, clientX: from });
    for (const x of [from + (to - from) / 3, from + ((to - from) * 2) / 3, to]) await view.dispatchEvent("pointermove", { ...init, clientX: x });
    await view.dispatchEvent("pointerup", { ...init, clientX: to });
  };
  await swipe(330, 60);
  await expect(page).toHaveURL(/\/lan$/u);
  await expect(tab(page, "Lån")).toHaveAttribute("aria-current", "page");
  await swipe(60, 330);
  await expect(page).toHaveURL(/\/budget$/u);
  // Svepen lade inte till steg: bakåt går till Översikt.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/u);
});
