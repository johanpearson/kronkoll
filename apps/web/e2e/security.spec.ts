// Säkerhet i produktionsbygget: säkerhetsheaders och strikt CSP på det som Pages levererar (V-e2e-csp,
// KK-30-B), och att Logga ut tömmer enheten och skickar till Access (V-e2e-logout, KK-35-A).
// API-svarens headers sätts av Pages Function och testas i server/api-proxy.test.ts.
import { expect, test } from "@playwright/test";
import { SECURITY_HEADERS } from "../server/security-headers.ts";
import { useFakeApi } from "./fake-api.ts";

for (const path of ["/", "/transaktioner", "/sw.js", "/manifest.webmanifest"]) {
  test(`${path} har alla säkerhetsheaders och en strikt CSP (KK-30-B)`, async ({ request }) => {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    const headers = response.headers();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(headers[name.toLowerCase()], name).toBe(value);
    for (const directive of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "connect-src 'self'"]) {
      expect(headers["content-security-policy"]).toContain(directive);
    }
    expect(headers["content-security-policy"]).not.toContain("unsafe");
  });
}

test.describe("Logga ut och rensa enheten (KK-35-A)", () => {
  test.use({ serviceWorkers: "allow" });

  test("tömmer Cache Storage, IndexedDB och lagringen, och skickar sedan till Access", async ({ page, context }) => {
    await useFakeApi(context);
    // Access finns inte lokalt. Utloggningssidan ersätts med en tom sida på samma adress.
    await context.route("**/cdn-cgi/access/logout", (route) => route.fulfill({ contentType: "text/html", body: "<title>Access</title>" }));

    // Fyll enheten: skalet och översikten i Cache Storage, en IndexedDB-databas och ett sparat tema.
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.reload();
    await expect(page.getByRole("main")).toContainText("8 582,00 kr");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const open = indexedDB.open("kronkoll-test");
          open.onsuccess = () => {
            open.result.close();
            resolve();
          };
        }),
    );
    await page.evaluate(() => { localStorage.setItem("kronkoll.theme", "dark"); });
    expect(await page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(["kronkoll-skal-v1", "kronkoll-data-v1"]));

    await page.getByRole("button", { name: "Inställningar" }).click();
    await page.getByRole("button", { name: "Logga ut och rensa enheten" }).click();
    await page.waitForURL("**/cdn-cgi/access/logout");

    expect(await page.evaluate(() => caches.keys())).toEqual([]);
    expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).toEqual([]);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  });
});
