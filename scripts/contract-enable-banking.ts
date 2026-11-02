// Kontraktstest mot Enable Bankings sandbox (V-c-provider, F-contract-nightly, KK-5-C).
// Kör den riktiga adaptern mot sandboxen och kontrollerar att svaren går att mappa och följer
// domänens regler. Sammanfattningen innehåller bara antal och datum, aldrig belopp, motparter
// eller id:n (KK-13). Den besvarar också spikens öppna frågor: kommer preliminära, hur långt
// bakåt går historiken och hur lång tid tar en sida (risk R-3).
import { appendFileSync } from "node:fs";
import { ProviderError, type ProviderTransaction } from "../packages/domain/src/index.ts";
import { createEnableBankingProvider, createJwtSigner } from "../packages/adapter-enablebanking/src/index.ts";

const sessionId = process.env.EB_SESSION_ID ?? "";
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const HISTORY_DAYS = 730;
const MAX_PAGES = 50;

const lines: string[] = [];
const out = (line = "") => lines.push(line);
// Både sammanfattning och logg: GitHub-appen i mobilen visar bara loggen. Texten innehåller
// bara antal och datum, så den är lika ofarlig i loggen.
const flush = () => {
  const text = `${lines.join("\n")}\n`;
  if (summaryFile) appendFileSync(summaryFile, text);
  process.stdout.write(text);
};
const failures: string[] = [];
const expect = (ok: boolean, rule: string) => {
  if (!ok) failures.push(rule);
};

if (sessionId === "") {
  out("## Kontraktstest: Enable Banking (sandbox)");
  out();
  out("Hoppas över: ingen sandbox-session. Kör workflowen **sandbox-connect**.");
  flush();
  process.exit(0);
}

const provider = createEnableBankingProvider({
  signer: createJwtSigner({
    applicationId: process.env.EB_APP_ID ?? "",
    privateKeyPem: process.env.EB_PRIVATE_KEY ?? "",
    now: () => Date.now(),
  }),
  fetch,
});

const ISO = /^\d{4}-\d{2}-\d{2}$/u;
const dateFrom = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);

out("## Kontraktstest: Enable Banking (sandbox)");
out();
try {
  const accounts = await provider.accounts(sessionId);
  expect(accounts.length > 0, "sessionen har minst ett konto");
  out(`Konton: **${String(accounts.length)}** (${accounts.map((a) => a.type).join(", ")})`);
  out();
  out("| Konto | Saldo finns | Sidor | Bokförda | Preliminära | Äldsta datum | Längsta sida (ms) |");
  out("|---|---|---|---|---|---|---|");

  for (const [index, account] of accounts.entries()) {
    expect(account.providerUid !== "", "kontot har ett uid");
    const balance = await provider.balance(account.providerUid);
    expect(balance === null || Number.isSafeInteger(balance), "saldot är heltal öre");

    const all: ProviderTransaction[] = [];
    let key: string | null = null;
    let pages = 0;
    let slowest = 0;
    do {
      const started = performance.now();
      const page = await provider.transactions(account.providerUid, { dateFrom, continuationKey: key });
      slowest = Math.max(slowest, performance.now() - started);
      all.push(...page.transactions);
      expect(page.continuationKey !== key || key === null, "continuation key byts mellan sidor");
      key = page.continuationKey;
      pages += 1;
    } while (key !== null && pages < MAX_PAGES);
    expect(key === null, `historiken tar slut inom ${String(MAX_PAGES)} sidor`);

    for (const t of all) {
      expect(Number.isSafeInteger(t.amountMinor) && t.amountMinor !== 0, "beloppet är heltal öre och inte noll");
      expect(ISO.test(t.transactionDate), "transaktionsdatum är YYYY-MM-DD");
      expect(t.status === "pending" || t.bookingDate !== null, "en bokförd transaktion har bokföringsdatum");
      expect(t.description.length <= 140, "beskrivningen är högst 140 tecken");
    }
    const ids = all.map((t) => t.providerTxId).filter((id) => id !== null);
    expect(new Set(ids).size === ids.length, "bankens id är unika inom kontot");

    const booked = all.filter((t) => t.status === "booked").length;
    const oldest = all.map((t) => t.transactionDate).sort()[0] ?? "–";
    out(`| ${String(index + 1)} (${account.type}) | ${balance === null ? "nej" : "ja"} | ${String(pages)} | ${String(booked)} | ${String(all.length - booked)} | ${oldest} | ${slowest.toFixed(0)} |`);
  }
} catch (error) {
  if (error instanceof ProviderError && error.code === "UNAUTHORIZED") {
    out("Sandbox-sessionen har gått ut eller återkallats. Kör workflowen **sandbox-connect** igen.");
  } else {
    out(`Fel: ${error instanceof ProviderError ? error.code : "okänt"}`);
  }
  flush();
  process.exit(1);
}

out();
out("*Tiden per sida är väntetid inklusive nätverk, inte Workerns CPU-tid, men visar storleksordningen.*");
const unique = [...new Set(failures)];
if (unique.length > 0) {
  out();
  out("### Regler som inte höll");
  for (const rule of unique) out(`- ${rule}`);
}
flush();
process.exit(unique.length > 0 ? 1 : 0);
