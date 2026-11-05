// Installbar PWA (KK-25, V-e2e-pwa): manifest, ikoner och service worker i produktionsbygget.
// Chromium avgör själv om appen går att installera (Page.getInstallabilityErrors). Utan nät startar
// skalet från service workern och visar den senast hämtade översikten med när den hämtades.
import { expect, test } from "@playwright/test";
import { useFakeApi } from "./fake-api.ts";

test.use({ serviceWorkers: "allow" });

test("appen går att installera, och utan nät visas senaste översikten med tidsstämpel (KK-25-A, KK-25-B)", async ({ page, context }) => {
  await useFakeApi(context);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Översikt" })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: { errorId: string }[] };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);

  const manifest = (await (await page.request.get("/manifest.webmanifest")).json()) as { icons: { src: string; sizes: string }[] };
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok(), icon.src).toBe(true);

  // Andra laddningen går genom service workern, som då sparar översikten.
  await page.reload();
  await expect(page.getByRole("main")).toContainText("8 582,00 kr");
  await expect(page.getByRole("note")).toHaveCount(0);

  // Utan nät. Det påhittade API:t skulle annars svara ändå, så det tas bort först.
  await context.unrouteAll();
  await context.setOffline(true);
  const offline = await page.reload();
  expect(offline?.fromServiceWorker()).toBe(true);
  await expect(page.getByRole("note")).toContainText(/^Offline – visar data från \d+ nov\. \d\d:\d\d\.$/u);
  await expect(page.getByRole("main")).toContainText("8 582,00 kr");
});

test("med service worker och tillåtna notiser visas reglagen för notiser, alla avslagna från början (KK-27)", async ({ page, context }) => {
  await useFakeApi(context);
  await context.grantPermissions(["notifications"]);
  await page.goto("/installningar");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  for (const name of ["Samtycket går snart ut (14, 3 och 0 dagar före)", "Budget överskriden", "Synken misslyckas flera gånger i rad"]) {
    await expect(page.getByRole("checkbox", { name })).not.toBeChecked();
  }
  await expect(page.getByRole("main")).toContainText("Notiserna innehåller aldrig belopp.");
});