// De kritiska flödena i mobil viewport (KK-15-B): översikten, att kategorisera med en regel som
// lär sig och att sätta budget. Data kommer från det påhittade API:t i fake-api.ts.
import { expect, test } from "@playwright/test";
import { useFakeApi } from "./fake-api.ts";

test("översikten visar periodens saldo, saldo per konto, in, ut och kvar att spendera (V-e2e-dashboard, KK-38)", async ({ page }) => {
  await useFakeApi(page);
  const response = await page.goto("/");
  // Bygget körs med samma _headers som i drift (KK-30-B).
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Översikt" })).toBeVisible();
  await expect(main).toContainText("November");
  await expect(main.getByRole("definition")).toHaveText(["48 312,40 kr", "41 250,00 kr", "23 418,00 kr"]);
  await expect(main.getByRole("term").first()).toHaveText("Saldo (2 av 3 konton)");
  const accounts = main.getByRole("list", { name: "Konton" }).getByRole("listitem");
  await expect(accounts).toContainText(["Vardag", "Sparkonto ••7712", "Kort ••1190"]);
  await expect(accounts).toContainText(["18 527,90 kr", "29 784,50 kr", "Saldo saknas"]);
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
  for (const r of await rows.all()) {
    await expect(r).toContainText("Hushåll › Förbrukning");
    // Huvudkategorins färg som en prick bredvid namnet (KK-26-D).
    await expect(r.locator(".cat-dot.cat-violet")).toBeVisible();
  }
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
  // Bekräftelsen är en notis som försvinner av sig själv (KK-26-C).
  await expect(page.getByRole("status")).toBeHidden({ timeout: 6000 });
  await page.reload();
  await expect(page.getByText("Ingen budget är satt för perioden än.")).toBeVisible();
});

test("skapa ett sparmål, se det i listan och lägg till en avsättning (V-e2e-goal, KK-21)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("link", { name: "Sparmål" }).click();
  await page.getByRole("button", { name: "Nytt sparmål" }).click();
  const form = page.getByRole("form", { name: "Nytt sparmål" });
  await form.getByLabel("Namn").fill("Ny cykel");
  await form.getByLabel("Målbelopp (kr)").fill("12 000");
  await form.getByLabel("Måldatum (valfritt)").fill("2027-06-30");
  await form.getByRole("button", { name: "Skapa sparmål" }).click();

  await expect(page.getByRole("status")).toHaveText("Sparmålet är skapat.");
  const row = page.getByRole("list", { name: "Dina sparmål" }).getByRole("listitem").filter({ hasText: "Ny cykel" });
  await expect(row).toContainText("0,00 kr av 12 000,00 kr");
  await expect(row).toContainText("Nås inte i nuvarande takt");

  await row.getByRole("link", { name: "Ny cykel" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ny cykel" })).toBeVisible();
  const deposit = page.getByRole("form", { name: "Ny avsättning" });
  await deposit.getByLabel("Belopp (kr)").fill("3 000");
  await deposit.getByRole("button", { name: "Lägg till" }).click();
  await expect(page.getByRole("status")).toHaveText("Avsättningen är sparad.");
  await expect(page.getByRole("main")).toContainText("3 000,00 kr av 12 000,00 kr (25 %)");
  await expect(page.getByRole("list", { name: "Avsättningar" }).getByRole("listitem")).toHaveCount(1);
});
test("planera föräldraledighet och se den under Inkomst (V-e2e-leave, KK-23)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("link", { name: "Inkomst" }).click();
  await page.getByRole("button", { name: "Planera ledighet" }).click();
  const form = page.getByRole("form", { name: "Planera föräldraledighet" });
  await form.getByLabel("Från").fill("2028-01-01");
  await form.getByLabel("Till").fill("2028-06-30");
  await form.getByLabel("Uttag").selectOption({ label: "3 dagar/vecka" });
  await form.getByLabel("Årsinkomst för SGI (kr)").fill("540 000");
  await form.getByLabel("Skattesats (%)").fill("31,5");
  await form.getByRole("button", { name: "Spara" }).click();

  await expect(page.getByRole("status")).toHaveText("Ledigheten är planerad.");
  const rows = page.getByRole("list", { name: "Planerade perioder" }).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("3 dagar/vecka");
});
test("sparmålets sida visar hur planerad ledighet försenar målet (KK-23-C)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/sparmal/g1");
  await expect(page.getByRole("note").filter({ hasText: "Med ledighet" })).toContainText("nås målet mars 2028, 3 mån senare.");
});
test("ändra en inbetalnings inkomsttyp på transaktionens sida (KK-22-A)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/transaktioner/lon1");
  await expect(page.getByRole("group", { name: "Inkomsttyp" }).getByLabel("Övrigt")).toBeChecked();
  await page.getByRole("group", { name: "Inkomsttyp" }).getByLabel("Lön").check();
  await expect(page.getByRole("status")).toHaveText("Inkomsttypen är sparad. 2 tidigare inbetalningar fick samma typ.");
  await expect(page.getByRole("main")).toContainText("Lön (vald av dig)");
});