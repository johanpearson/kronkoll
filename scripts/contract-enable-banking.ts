// Kontraktstest mot Enable Bankings sandbox (V-c-provider, F-contract-nightly, KK-5-C, KK-14-B).
// Kör den riktiga adaptern mot sandboxen genom den gemensamma kontraktssviten för porten
// BankDataProvider (packages/domain/src/provider-contract.ts). Sammanfattningen innehåller bara
// antal och datum, aldrig belopp, motparter eller id:n (KK-13). Den visar också om preliminära
// kommer, hur långt bakåt historiken går och hur lång tid en sida tar (risk R-3).
import { appendFileSync } from "node:fs";
import { ProviderError, runProviderContract, type BankDataProvider } from "../packages/domain/src/index.ts";
import { createEnableBankingProvider, createJwtSigner } from "../packages/adapter-enablebanking/src/index.ts";

const sessionId = process.env.EB_SESSION_ID ?? "";
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
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

if (sessionId === "") {
  out("## Kontraktstest: Enable Banking (sandbox)");
  out();
  out("Hoppas över: ingen sandbox-session. Kör workflowen **sandbox-connect**.");
  flush();
  process.exit(0);
}

// Vilket steg som pågår och bankens senaste HTTP-status, så att ett fel går att felsöka.
// Bara statuskoden sparas, aldrig svarstexten (KK-13).
let stepName = "";
const last: { status: number | null } = { status: null };
const adapter = createEnableBankingProvider({
  signer: createJwtSigner({
    applicationId: process.env.EB_APP_ID ?? "",
    privateKeyPem: process.env.EB_PRIVATE_KEY ?? "",
    now: () => Date.now(),
  }),
  fetch: async (input, init) => {
    const res = await fetch(input, init);
    last.status = res.status;
    return res;
  },
});

// Längsta sidan per konto, i den ordning kontona hämtas.
const slowest = new Map<string, number>();
const provider: BankDataProvider = {
  ...adapter,
  async transactions(accountUid, query) {
    const started = performance.now();
    const page = await adapter.transactions(accountUid, query);
    slowest.set(accountUid, Math.max(slowest.get(accountUid) ?? 0, performance.now() - started));
    return page;
  },
};

out("## Kontraktstest: Enable Banking (sandbox)");
out();
let failures: readonly string[] = [];
try {
  const report = await runProviderContract(provider, sessionId, { maxPages: MAX_PAGES, onStep: (step) => (stepName = step) });
  failures = report.failures;
  const times = [...slowest.values()];
  out(`Konton: **${String(report.accounts.length)}** (${report.accounts.map((a) => a.type).join(", ")})`);
  out();
  out("| Konto | Saldo finns | Sidor | Bokförda | Preliminära | Äldsta datum | Längsta sida (ms) |");
  out("|---|---|---|---|---|---|---|");
  for (const [index, a] of report.accounts.entries()) {
    out(`| ${String(index + 1)} (${a.type}) | ${a.hasBalance ? "ja" : "nej"} | ${String(a.pages)} | ${String(a.booked)} | ${String(a.pending)} | ${a.oldest ?? "–"} | ${(times[index] ?? 0).toFixed(0)} |`);
  }
} catch (error) {
  if (error instanceof ProviderError && error.code === "UNAUTHORIZED") {
    out("Sandbox-sessionen har gått ut eller återkallats. Kör workflowen **sandbox-connect** igen.");
  } else {
    const status = last.status === null ? "inget svar" : `HTTP ${String(last.status)}`;
    out(`Fel vid ${stepName}: ${error instanceof ProviderError ? error.code : "okänt"} (${status})`);
  }
  flush();
  process.exit(1);
}

out();
out("*Tiden per sida är väntetid inklusive nätverk, inte Workerns CPU-tid, men visar storleksordningen.*");
if (failures.length > 0) {
  out();
  out("### Regler som inte höll");
  for (const rule of failures) out(`- ${rule}`);
}
flush();
process.exit(failures.length > 0 ? 1 : 0);
