// De kritiska flödena i mobil viewport (KK-15-B): översikten, att kategorisera med en regel som
// lär sig och att sätta budget. Data kommer från det påhittade API:t i fake-api.ts.
import { expect, test } from "@playwright/test";
import { useFakeApi } from "./fake-api.ts";

test("översikten visar periodens saldo, in, ut och kvar att spendera (V-e2e-dashboard)", async ({ page }) => {
  await useFakeApi(page);
  const response = await page.goto("/");
  // Bygget körs med samma _headers som i drift (KK-30-B).
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Översikt" })).toBeVisible();
  await expect(main).toContainText("November");
  await expect(main.getByRole("definition")).toHaveText(["48 312,40 kr", "41 250,00 kr", "23 418,00 kr"]);
  await expect(main).toContainText("8 582,00 kr");
  await expect(main).toContainText("73 % av periodens budget är använd");
});

test("kategorisera med Gör alltid så skapar en regel som även tar tidigare köp (V-e2e-categorize)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("link", { name: "Transaktioner" }).click();

  await page.getByRole("button", { name: "Ändra kategori för Hörnbutiken Exempelvägen" }).first().click();
  await page.getByRole("combobox", { name: "Kategori" }).selectOption({ label: "Hushåll › Förbrukning" });
  await page.getByRole("checkbox", { name: "Gör alltid så för Hörnbutiken Exempelvägen" }).check();
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByText("Regeln matchar 1 tidigare transaktioner.")).toBeVisible();
  await page.getByRole("button", { name: "Applicera på dem" }).click();

  // Listan är grupperad per dag. En rad är ett listelement utan dagens rubrik.
  const row = (name: string) => page.getByRole("listitem").filter({ hasText: name, hasNot: page.getByRole("heading") });
  const rows = row("Hörnbutiken Exempelvägen");
  await expect(rows).toHaveCount(2);
  for (const r of await rows.all()) await expect(r).toContainText("Hushåll › Förbrukning");
  await expect(row("Påhittade Möbler AB")).not.toContainText("Hushåll");

  await page.goto("/installningar/regler");
  await expect(page.getByRole("main")).toContainText("HÖRNBUTIKEN EXEMPELVÄGEN");
});

test("sätt budget från snittet, justera Mat och se att den är över (V-e2e-budget)", async ({ page }) => {
  const api = await useFakeApi(page);
  await page.goto("/budget");
  await page.getByRole("button", { name: "Sätt budget" }).click();
  const form = page.getByRole("form", { name: "Sätt budget" });
  await form.getByRole("button", { name: "Föreslå från snitt" }).click();
  await expect(form.getByLabel("Mat", { exact: true })).toHaveValue("6070");
  await form.getByLabel("Mat", { exact: true }).fill("6300");
  await form.getByRole("button", { name: "Spara" }).click();

  await expect.poll(() => api.budgetPuts).toEqual([{ lines: [{ category_id: "boende", amount_minor: 980000 }, { category_id: "mat", amount_minor: 630000 }], source: "manual" }]);
  await expect(page.getByRole("list", { name: "Kategorier" }).getByRole("listitem").filter({ hasText: "Mat" })).toContainText("104 % – över");
});

test("ta bort periodens budget efter en fråga (KK-40)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/budget");
  await page.getByRole("button", { name: "Sätt budget" }).click();
  await page.getByRole("form", { name: "Sätt budget" }).getByLabel("Mat", { exact: true }).fill("6300");
  await page.getByRole("form", { name: "Sätt budget" }).getByRole("button", { name: "Spara" }).click();

  await page.getByRole("button", { name: "Ta bort budget" }).click();
  const dialog = page.getByRole("region", { name: "Ta bort budgeten" });
  await dialog.getByRole("button", { name: "Avbryt" }).click();
  await expect(page.getByRole("button", { name: "Ändra budget" })).toBeVisible();

  await page.getByRole("button", { name: "Ta bort budget" }).click();
  await dialog.getByRole("button", { name: "Ta bort budget" }).click();
  await expect(page.getByRole("status")).toHaveText("Budgeten för perioden är borttagen.");
  await expect(page.getByRole("button", { name: "Sätt budget" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Ingen budget är satt för perioden än.")).toBeVisible();
});
