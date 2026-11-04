// Lighthouse på produktionsbygget i mobilläge (KK-25, V-e2e-pwa): prestanda, tillgänglighet och bästa
// praxis. Lighthouse öppnar en egen flik via Chrome DevTools-protokollet. Den fliken hör till samma
// webbläsarkontext som fake-API:t, så sidan visar påhittad data i stället för fel.
// Lighthouse 13 har ingen PWA-kategori längre. Installbarheten kontrolleras när appen får manifest.
import { chromium, expect, test } from "@playwright/test";
import lighthouse from "lighthouse";
import { useFakeApi } from "./fake-api.ts";

const PORT = 9223;

/** Lägsta poäng per kategori. Prestanda mäts med simulerad strypning och varierar lite mellan körningar. */
const MIN_SCORE = { performance: 0.9, accessibility: 1, "best-practices": 1 } as const;

for (const path of ["/", "/transaktioner"]) {
  test(`Lighthouse ${path}: prestanda, tillgänglighet och bästa praxis`, async ({ baseURL }) => {
    test.setTimeout(120_000);
    const context = await chromium.launchPersistentContext("", { args: [`--remote-debugging-port=${String(PORT)}`] });
    try {
      await useFakeApi(context);
      const result = await lighthouse(`${baseURL ?? ""}${path}`, { port: PORT, output: "json", logLevel: "error", onlyCategories: Object.keys(MIN_SCORE) });
      const lhr = result?.lhr;
      expect(lhr?.runtimeError).toBeUndefined();
      const failing = Object.values(lhr?.audits ?? {})
        .filter((a) => a.score !== null && a.score < 1 && a.scoreDisplayMode === "binary")
        .map((a) => a.id);
      for (const [id, min] of Object.entries(MIN_SCORE)) {
        const score = lhr?.categories[id]?.score ?? 0;
        expect(score, `${id} ${String(score)}, underkända granskningar: ${failing.join(", ") || "inga"}`).toBeGreaterThanOrEqual(min);
      }
    } finally {
      await context.close();
    }
  });
}
