// Installbar PWA (KK-25-A, V-e2e-pwa): manifest, ikoner och service worker i produktionsbygget.
// Chromium avgör själv om appen går att installera (Page.getInstallabilityErrors), och skalet ska
// starta utan nät när service workern har sparat det. Offline-data kommer i en egen PR (KK-25-B).
import { expect, test } from "@playwright/test";
import { useFakeApi } from "./fake-api.ts";

test("appen går att installera och skalet startar utan nät (KK-25-A)", async ({ page, context }) => {
  await useFakeApi(context);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Översikt" })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: { errorId: string }[] };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);

  const manifest = (await (await page.request.get("/manifest.webmanifest")).json()) as { icons: { src: string; sizes: string }[] };
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok(), icon.src).toBe(true);

  await context.setOffline(true);
  const offline = await page.reload();
  expect(offline?.fromServiceWorker()).toBe(true);
  await expect(page.getByRole("navigation")).toBeVisible();
});
