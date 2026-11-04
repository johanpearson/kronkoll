// Koppla bank (V-e2e-connect, KK-15-B) och samtyckesbannern (KK-8-A) i mobil viewport. Banken och
// BankID finns inte lokalt. Bankens sida ersätts med en omdirigering tillbaka till appen med code och
// state, precis som Enable Banking gör. Bankens sida testas mot sandboxen i kontraktstestet och i
// workflowen sandbox-connect (ägarens beslut 2026-11-04).
import { expect, test, type Page } from "@playwright/test";
import { FAKE_BANK, useFakeApi } from "./fake-api.ts";

/** Banken skickar tillbaka till appen med de parametrar som anges, t.ex. code och state. */
async function bankReturns(page: Page, params: string) {
  await page.route(`${FAKE_BANK}/**`, async (route) => {
    const back = new URL(`/koppla/klar?${params}`, page.url()).href;
    await route.fulfill({ status: 302, headers: { location: back } });
  });
}

async function startConnecting(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Välkommen till Kronkoll" })).toBeVisible();
  await page.getByRole("link", { name: "Koppla bank" }).click();
  await page.getByRole("link", { name: "Skandia – Konton och kort" }).click();
  await expect(page.getByRole("heading", { name: "Kronkoll vill läsa från Skandia" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Inga betalningar eller överföringar");
  await page.getByRole("button", { name: "Fortsätt till BankID" }).click();
}

test("koppla bank: välj Skandia, godkänn, tillbaka från banken och se kontona (V-e2e-connect)", async ({ page }) => {
  await useFakeApi(page, { connected: false });
  await bankReturns(page, "code=c-1&state=s-1");
  await startConnecting(page);

  await expect(page.getByRole("heading", { name: "Kopplat! Hämtar historik…" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("3 konton hittades.");
  // Koden från banken ligger inte kvar i adressfältet.
  expect(new URL(page.url()).search).toBe("");

  await page.getByRole("link", { name: "Till start" }).click();
  await expect(page.getByRole("heading", { name: "Översikt" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Konton" }).getByRole("listitem")).toHaveCount(3);
});

test("avbryter man hos banken sparas inget och man kan börja om", async ({ page }) => {
  await useFakeApi(page, { connected: false });
  await bankReturns(page, "error=access_denied&state=s-1");
  await startConnecting(page);

  await expect(page.getByRole("alert")).toHaveText("Kopplingen avbröts hos banken. Inget sparades.");
  await page.getByRole("link", { name: "Försök igen" }).click();
  await expect(page.getByRole("heading", { name: "Koppla bank" })).toBeVisible();
});

test("14 dagar innan samtycket går ut visar översikten en varning med länk för att förnya (KK-8-A)", async ({ page }) => {
  await useFakeApi(page, { consentDaysLeft: 14 });
  await page.goto("/");
  const banner = page.getByRole("alert");
  await expect(banner).toContainText("Kopplingen till Exempelbanken går ut om 14 dagar.");
  await banner.getByRole("link", { name: "Förnya med BankID" }).click();
  await expect(page).toHaveURL(/\/installningar\/koppling\/c1$/u);
});
