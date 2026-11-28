// De kritiska flödena i mobil viewport (KK-15-B): översikten, att kategorisera med en regel som
// lär sig och att sätta budget. Data kommer från det påhittade API:t i fake-api.ts.
import { readFile } from "node:fs/promises";
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
  // Regeln tillämpas direkt på det tidigare köpet, utan fråga (KK-58-A).
  await expect(page.getByText("1 transaktioner fick den nya kategorin.")).toBeVisible();

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

test("välj flera transaktioner, dölj dem och visa dem igen (V-e2e-hide, KK-49)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/transaktioner");
  // Listan är grupperad per dag. En rad är ett listelement utan dagens rubrik.
  const row = (name: string) => page.getByRole("main").getByRole("listitem").filter({ hasText: name, hasNot: page.getByRole("heading") });
  await expect(row("Påhittade Möbler AB")).toHaveCount(1);
  await page.getByRole("button", { name: "Välj flera" }).click();
  await page.getByRole("checkbox", { name: "Välj Påhittade Möbler AB" }).check();
  await expect(page.getByText("1 valda")).toBeVisible();
  await page.getByRole("button", { name: "Dölj" }).click();
  await expect(page.getByRole("status").locator("p")).toHaveText("1 transaktion är dold. De finns under Visa dolda.");
  // Notisen syns upptill, aldrig över flikmenyn, och har Ångra (KK-64-B, F).
  const box = await page.getByRole("status").boundingBox();
  expect(box?.y ?? 999).toBeLessThan(100);
  await expect(page.getByRole("status").getByRole("button", { name: "Ångra" })).toBeVisible();
  await expect(row("Påhittade Möbler AB")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "Visa dolda" }).check();
  await expect(row("Påhittade Möbler AB")).toContainText("Dold");
  await page.getByRole("button", { name: "Välj flera" }).click();
  await page.getByRole("checkbox", { name: "Välj Påhittade Möbler AB" }).check();
  await page.getByRole("button", { name: "Visa igen" }).click();
  await expect(page.getByRole("status").locator("p")).toHaveText("1 transaktion visas igen.");
  await page.getByRole("checkbox", { name: "Visa dolda" }).uncheck();
  await expect(row("Påhittade Möbler AB")).toHaveCount(1);
});

test("lägg till en regel som innehåller en text, oavsett versaler (V-e2e-rule-contains, KK-47)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/installningar/regler");
  await page.getByRole("button", { name: "Ny regel" }).click();
  await page.getByRole("radio", { name: "Innehåller" }).click();
  await page.getByLabel("Text").fill("Amazon");
  await page.getByLabel("Får kategorin").selectOption({ label: "Hushåll › Förbrukning" });
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByRole("status")).toHaveText("Regeln är sparad och gäller nya transaktioner.");
  await expect(page.getByRole("list", { name: "Regler" }).getByRole("listitem").filter({ hasText: "AMAZON" })).toContainText("Innehåller AMAZON → Hushåll › Förbrukning");
});

test("ordna reglerna: den som står först vinner, och ordningen finns kvar efter omladdning (V-e2e-rule-order, KK-58-C)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/installningar/regler");
  for (const [match, text] of [["prefix", "Ikea"], ["contains", "Amazon"]] as const) {
    await page.getByRole("button", { name: "Ny regel" }).click();
    await page.getByRole("radio", { name: match === "contains" ? "Innehåller" : "Börjar med" }).click();
    await page.getByLabel("Text").fill(text);
    await page.getByLabel("Får kategorin").selectOption({ label: "Hushåll › Förbrukning" });
    await page.getByRole("button", { name: "Spara" }).click();
    await expect(page.getByRole("status")).toContainText("Regeln är sparad");
  }
  const rules = page.getByRole("list", { name: "Regler" }).getByRole("listitem");
  // Den nyaste regeln står först, som i det riktiga API:t.
  await expect(rules).toContainText(["Innehåller AMAZON", "Börjar med IKEA"]);
  await rules.filter({ hasText: "IKEA" }).getByRole("button").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("status")).toContainText("Plats 2 av 2");
  await sheet.getByRole("button", { name: "Flytta upp" }).click();
  await expect(sheet.getByRole("status")).toContainText("Plats 1 av 2");
  await sheet.getByRole("button", { name: "Stäng" }).click();
  await expect(rules).toContainText(["Börjar med IKEA", "Innehåller AMAZON"]);
  // Arkets steg i historiken ska vara borta innan sidan laddas om.
  await page.waitForFunction(() => (history.state as { overlay?: boolean } | null)?.overlay !== true);
  await page.goto("/installningar/regler");
  await expect(rules).toContainText(["Börjar med IKEA", "Innehåller AMAZON"]);
});

test("rensa alla kategorier efter en fråga och börja om (V-e2e-categories-reset, KK-48)", async ({ page }) => {
  const api = await useFakeApi(page);
  await page.goto("/installningar/kategorier");
  await page.getByRole("button", { name: "Rensa alla kategorier" }).click();
  const dialog = page.getByRole("dialog", { name: "Rensa alla kategorier?" });
  await expect(dialog).toContainText("37 kategorier och 14 regler tas bort");
  await dialog.getByRole("button", { name: "Rensa alla kategorier" }).click();
  await expect(page.getByRole("status")).toHaveText("Alla kategorier är rensade. Lägg till nya från början.");
  await expect(page.getByText("Det finns inga kategorier.")).toBeVisible();
  expect(api.categoryResets).toEqual([{ confirm: true, restore_template: false }]);
});

test("planera en budget från förväntad inkomst, se vad som blir över och spara den (V-e2e-planner, KK-42)", async ({ page }) => {
  const api = await useFakeApi(page);
  await page.goto("/budget");
  await expect(page.getByRole("heading", { name: "Budget" })).toBeVisible();
  // Inkomsten är förifylld med förväntad inkomst, och en rad till går att lägga till.
  await expect(page.getByLabel("Belopp för Lön (kr)")).toHaveValue("40000");
  await page.getByRole("button", { name: "Lägg till inkomst" }).click();
  await page.getByLabel("Namn på inkomsten").nth(1).fill("Barnbidrag");
  await page.getByLabel("Belopp för Barnbidrag (kr)").fill("1250");

  // För höga utgifter ger ett underskott som står i text, inte bara i färg.
  await page.getByLabel("Utgift för Mat (kr)").fill("45000");
  const summary = page.getByRole("region", { name: "Summering" });
  await expect(summary).toContainText("Underskott");
  await expect(page.getByRole("note")).toContainText("mer än inkomsten");

  await page.getByLabel("Utgift för Mat (kr)").fill("6300");
  await expect(summary).toContainText("Blir över");
  await expect(summary).toContainText("25 150,00 kr");

  await page.getByRole("button", { name: "Spara som budget för perioden" }).click();
  await expect.poll(() => api.budgetPuts).toEqual([{ lines: [{ category_id: "boende", amount_minor: 980000 }, { category_id: "mat", amount_minor: 630000 }], source: "manual" }]);
  await expect(page.getByRole("status")).toHaveText("Budgeten för perioden är sparad.");
  // Utfallet står i text mot det som är planerat (KK-45-A): Mat är över med 6 300 kr mot ett utfall på 6 552 kr.
  await expect(page.getByRole("list", { name: "Utgifter" }).getByRole("listitem").filter({ hasText: "Mat" })).toContainText("104 % – över");
});

test("exportera budgeten som Excel och som PDF (V-e2e-export, KK-43)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/budget");
  // Skrivbordswebbläsaren har ingen delningsmeny, så filerna laddas ned. Excel-biblioteket hämtas först här
  // och måste få köra under samma CSP som i drift.
  const excel = page.waitForEvent("download");
  await page.getByRole("button", { name: "Excel (.xlsx)" }).click();
  const xlsx = await excel;
  expect(xlsx.suggestedFilename()).toBe("kronkoll-budget-2026-11.xlsx");
  // En .xlsx-fil är ett zip-arkiv.
  expect((await readFile((await xlsx.path()))).subarray(0, 4).toString("hex")).toBe("504b0304");
  await expect(page.getByRole("status")).toHaveText("Filen är nedladdad.");
  const sheet = page.waitForEvent("download");
  await page.getByRole("button", { name: "Lättläst sida (PDF)" }).click();
  expect((await sheet).suggestedFilename()).toBe("kronkoll-budget-2026-11.pdf");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("ta bort periodens budget efter en fråga (KK-40)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/budget");
  await expect(page.getByRole("button", { name: "Ta bort budget" })).toHaveCount(0);
  await page.getByLabel("Utgift för Mat (kr)").fill("6300");
  await page.getByRole("button", { name: "Spara som budget för perioden" }).click();
  await expect(page.getByRole("status")).toHaveText("Budgeten för perioden är sparad.");

  await page.getByRole("button", { name: "Ta bort budget" }).click();
  const dialog = page.getByRole("region", { name: "Ta bort budgeten" });
  await dialog.getByRole("button", { name: "Avbryt" }).click();
  await expect(page.getByRole("button", { name: "Ta bort budget" })).toBeVisible();

  await page.getByRole("button", { name: "Ta bort budget" }).click();
  await dialog.getByRole("button", { name: "Ta bort budget" }).click();
  await expect(page.getByRole("status")).toHaveText("Budgeten för perioden är borttagen.");
  await expect(page.getByRole("button", { name: "Ta bort budget" })).toHaveCount(0);
  // Bekräftelsen är en notis som försvinner av sig själv (KK-26-C).
  await expect(page.getByRole("status")).toBeHidden({ timeout: 6000 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Ta bort budget" })).toHaveCount(0);
});

test("se vilka inbetalningar som räknas som inkomst en månad och gå till dem (KK-46)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/inkomst");
  await page.getByRole("button", { name: "Visa det som räknas i oktober 2026" }).click();
  const items = page.getByRole("list", { name: "Inbetalningar Oktober 2026" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("Påhittade Bygg AB");
  await expect(items.nth(1)).toContainText("Swish från Anna");
  await expect(items.nth(1)).toContainText("Inte klassad");
  await items.first().getByRole("link").click();
  await expect(page).toHaveURL(/\/transaktioner\/lon1$/u);
});
test("ändra en inbetalnings inkomsttyp på transaktionens sida (KK-22-A)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/transaktioner/lon1");
  await expect(page.getByRole("group", { name: "Inkomsttyp" }).getByLabel("Övrigt")).toBeChecked();
  await page.getByRole("group", { name: "Inkomsttyp" }).getByLabel("Lön").check();
  await expect(page.getByRole("status")).toHaveText("Inkomsttypen är sparad. 2 tidigare inbetalningar fick samma typ.");
  await expect(page.getByRole("main")).toContainText("Lön (vald av dig)");
});
test("lägg till ett lån och se det i lånöversikten (V-e2e-loans, KK-36)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("link", { name: "Lån" }).click();
  // Lånens egna rader, utan diagrammens dolda värdelistor.
  const loans = page.getByRole("list", { name: "Dina lån" }).locator(":scope > li");
  await expect(loans.first()).toContainText("Bindningstiden slutar om 41 dagar");
  await expect(loans.first()).toContainText("Betalt denna period");

  await page.getByRole("button", { name: "Lägg till lån" }).click();
  const form = page.getByRole("form", { name: "Nytt lån" });
  await form.getByLabel("Namn").fill("Billån");
  await form.getByLabel("Skuld (kr)").fill("86 000");
  await form.getByLabel("Ränta (%)").fill("6,95");
  await form.getByLabel("Amortering (kr/mån)").fill("2 450");
  // Kontouppgifter förhandsvisas innan de sparas (KK-59-A). Det påhittade API:t har inga träffar.
  await form.getByLabel("Kontouppgifter (valfritt)").fill("9020-12 345 67");
  await form.getByRole("button", { name: "Visa träffar" }).click();
  await expect(form.getByRole("status")).toHaveText("Inga betalningar träffar.");
  await form.getByRole("button", { name: "Spara" }).click();

  await expect(page.getByRole("status")).toHaveText("Lånet är sparat.");
  await expect(loans).toHaveCount(2);
  await expect(loans.nth(1)).toContainText("Rörlig ränta");
  await expect(page.getByRole("definition").first()).toHaveText("1 286 000,00 kr");
});
test("insikterna nås från översikten och visar avvikelse, återkommande dragningar och största utgifter (KK-24)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Insikter: avvikelser, återkommande dragningar och största utgifter" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Insikter");
  await expect(page.getByRole("list", { name: "Avvikelser" })).toContainText("Mat › Livsmedel");
  await expect(page.getByRole("list", { name: "Avvikelser" })).toContainText("+46 %");
  await expect(page.getByRole("list", { name: "Återkommande dragningar" }).getByRole("listitem")).toHaveCount(2);
  await page.getByRole("link", { name: "Möbelhuset Påhittat" }).click();
  await expect(page).toHaveURL(/\/transaktioner\/t1$/u);
});

test("ge ett konto rollen Buffert i Inställningar (V-e2e-account-role, KK-53-A)", async ({ page }) => {
  const api = await useFakeApi(page);
  await page.goto("/installningar/konton");
  const role = page.getByRole("radiogroup", { name: "Roll för Sparkonto ••5678" });
  await expect(role.getByRole("radio", { name: "Inkomst/Utgift" })).toHaveAttribute("aria-checked", "true");
  await role.getByRole("radio", { name: "Buffert" }).click();
  // Valet visas när servern har svarat.
  await expect(role.getByRole("radio", { name: "Buffert" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Sparande. Överföringar hit räknas som sparande och uttag härifrån som uttag från sparande.")).toBeVisible();
  expect(api.accountPatches).toEqual([{ role: "buffer" }]);
  await page.reload();
  await expect(page.getByRole("radiogroup", { name: "Roll för Sparkonto ••5678" }).getByRole("radio", { name: "Buffert" })).toHaveAttribute("aria-checked", "true");
});

test("välj ett konto i Transaktioner och se vilket filter som gäller (V-e2e-account-filter, KK-41-C)", async ({ page }) => {
  await useFakeApi(page);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/transaktioner");
  await page.getByRole("button", { name: "Vardag", exact: true }).click();
  await expect(page.getByText("Visar bara Vardag")).toBeVisible();
  await expect.poll(() => requests.some((url) => url.includes("/api/transactions?") && url.includes("account=acc_1"))).toBe(true);
  await page.getByRole("button", { name: "Visa alla konton" }).click();
  await expect(page.getByText(/Visar bara/u)).toHaveCount(0);
});

test("flytta en kategori upp och ner med knapparna, och ordningen finns kvar efter omladdning (V-e2e-category-order, KK-18-A)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/installningar/kategorier/mat");
  const subs = page.getByRole("list", { name: "Underkategorier" }).getByRole("listitem");
  await expect(subs).toHaveText(["Livsmedel", "Restaurang", "Systembolaget"]);
  await page.getByRole("button", { name: "Systembolaget" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("status")).toHaveText("Plats 3 av 3");
  // Arket är kvar efter en flytt, så att man kan flytta flera steg.
  await sheet.getByRole("button", { name: "Flytta upp" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Plats 2 av 3");
  await sheet.getByRole("button", { name: "Flytta upp" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Plats 1 av 3");
  await expect(sheet.getByRole("button", { name: "Flytta upp" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Stäng" }).click();
  await expect(subs).toHaveText(["Systembolaget", "Livsmedel", "Restaurang"]);
  await page.getByRole("button", { name: "Livsmedel" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Flytta ner" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stäng" }).click();
  await expect(subs).toHaveText(["Systembolaget", "Restaurang", "Livsmedel"]);
});

test("regelformuläret visar träffarna medan man skriver och valet att skriva över manuella (V-e2e-rule-preview, KK-58-B)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/installningar/regler");
  await page.getByRole("button", { name: "Ny regel" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Text").fill("Ikea");
  await sheet.getByLabel("Får kategorin").selectOption({ label: "Hushåll › Förbrukning" });
  await expect(sheet).toContainText("Regeln träffar 4 transaktioner: 2 får kategorin, 1 har redan kategorin, 1 är manuellt valda.");
  const examples = sheet.getByRole("list", { name: "Exempel på träffar" }).getByRole("listitem");
  await expect(examples).toHaveCount(3);
  await expect(examples.first()).toContainText("IKEA KARLSTAD");
  const toggle = sheet.getByRole("switch", { name: "Skriv över även manuellt kategoriserade" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(sheet).toContainText("1 manuellt valda ändras inte");
  await toggle.click();
  await expect(sheet).toContainText("1 manuellt valda får kategorin.");
  // Inget är sparat än: listan har inga regler förrän man trycker på Spara.
  await expect(page.getByRole("list", { name: "Regler" }).getByRole("listitem")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByRole("status")).toContainText("Regeln är sparad");
  await expect(page.getByRole("list", { name: "Regler" }).getByRole("listitem")).toHaveCount(1);
});

test("Visa träffar listar de senaste transaktionerna regeln gäller, med vad som händer med var och en (V-e2e-rule-matches, KK-18-C)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/installningar/regler");
  await page.getByRole("button", { name: "Ny regel" }).click();
  await page.getByLabel("Text").fill("Ikea");
  await page.getByLabel("Får kategorin").selectOption({ label: "Hushåll › Förbrukning" });
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByRole("status")).toContainText("Regeln är sparad");
  await page.getByRole("list", { name: "Regler" }).getByRole("button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Visa träffar" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Regeln träffar 4 transaktioner: 2 får kategorin, 1 har redan kategorin, 1 är manuellt valda. Visar de 3 senaste.");
  const rows = sheet.getByRole("list", { name: "Träffar" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("IKEA KARLSTAD");
  await expect(rows.nth(1)).toContainText("Okänd motpart");
  await expect(rows.nth(2)).toContainText("Manuellt vald, ändras inte");
});

test("Varför den här kategorin? förklarar varför en transaktion saknar kategori (V-e2e-category-reason, KK-58-D)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/transaktioner/lon1");
  await page.getByRole("button", { name: "Varför den här kategorin?" }).click();
  const sheet = page.getByRole("dialog", { name: "Varför den här kategorin?" });
  await expect(sheet).toContainText("Ingen kategori är vald, och ingen regel träffar den här transaktionen.");
  await sheet.getByRole("button", { name: "Stäng" }).click();
  await expect(sheet).toHaveCount(0);
});

test("lägg till ett känt konto, se träffarna innan det sparas och koppla en överföring för hand (V-e2e-known, KK-54-A, KK-54-C)", async ({ page }) => {
  await useFakeApi(page);
  await page.goto("/installningar/kanda-konton");
  await expect(page.getByText("Inga kända konton")).toBeVisible();
  await page.getByRole("button", { name: "Lägg till konto" }).first().click();
  const form = page.getByRole("form", { name: "Nytt känt konto" });
  await form.getByLabel("Namn").fill("Kontot A");
  await form.getByLabel("Texter i meddelandet").fill("Swish till Exempelkonto A");
  await form.getByLabel("Standardkategori").selectOption({ label: "Hushåll › Förbrukning" });
  // Antalet träffar visas innan något är sparat.
  await expect(form).toContainText("2 transaktioner träffar.");
  await expect(page.getByRole("list", { name: "Kända konton" })).toHaveCount(0);
  await form.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByRole("status")).toContainText("Kontot är sparat.");
  const rows = page.getByRole("list", { name: "Kända konton" }).getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Kontot A");

  // Koppla en överföring till kontot för hand i detaljvyn, och se det som text.
  await page.goto("/transaktioner/lon1");
  await page.getByRole("button", { name: "Koppla till känt konto" }).click();
  await page.getByRole("combobox", { name: "Känt konto" }).selectOption({ label: "Kontot A" });
  await page.getByRole("button", { name: "Koppla", exact: true }).click();
  await expect(page.getByText("Till: Kontot A (vald av dig)")).toBeVisible();
});
