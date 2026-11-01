// Spike #8 mot Enable Bankings sandbox (KK-6). Körs från GitHub Actions med sandbox-nyckeln.
// Den visar att JWT-signeringen fungerar mot det riktiga API:t och sammanfattar vilka banker
// som finns för ett land och hur länge ett samtycke får gälla. Den hämtar aldrig konton eller
// transaktioner, och skriver aldrig ut nyckeln eller token (KK-12, KK-13).
import { appendFileSync } from "node:fs";
import { createJwtSigner } from "../packages/adapter-enablebanking/src/index.ts";

interface Aspsp {
  name?: string;
  country?: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
  beta?: boolean;
}

const api = process.env.EB_API_URL ?? "https://api.enablebanking.com";
const country = process.env.EB_COUNTRY ?? "SE";
const lookFor = (process.env.EB_LOOK_FOR ?? "Skandia").toLowerCase();

const signer = createJwtSigner({
  applicationId: process.env.EB_APP_ID ?? "",
  privateKeyPem: process.env.EB_PRIVATE_KEY ?? "",
  now: () => Date.now(),
});

/** Bara enkla värden skrivs ut, aldrig objekt. */
const text = (value: unknown, fallback: string) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${await signer.sign()}` } });
  if (!res.ok) {
    // Felsvaret från Enable Banking innehåller en felkod, aldrig nyckel eller token.
    const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown };
    throw new Error(`${path} svarade ${String(res.status)} (${text(body.code, "")} ${text(body.message, "")})`);
  }
  return res.json();
}

const days = (seconds: number | undefined) =>
  seconds === undefined ? "okänt" : `${String(Math.round(seconds / 86400))} dagar`;

const lines: string[] = [];
const out = (line = "") => lines.push(line);

const app = (await get("/application")) as { environment?: unknown; active?: unknown };
out("## Spike: Enable Banking (sandbox)");
out();
out(`- JWT-signering godkänd av API:t: **ja**`);
out(`- Miljö: ${text(app.environment, "okänd")}, aktiv: ${text(app.active, "okänt")}`);

const { aspsps = [] } = (await get(`/aspsps?country=${encodeURIComponent(country)}`)) as { aspsps?: Aspsp[] };
const matches = aspsps.filter((a) => (a.name ?? "").toLowerCase().includes(lookFor));
out(`- Banker för ${country}: **${String(aspsps.length)}**`);
out(`- Träffar på "${lookFor}": **${matches.length > 0 ? matches.map((a) => a.name).join(", ") : "inga"}**`);
out();
out("| Bank | Kundtyper | Längsta samtycke | Beta |");
out("|---|---|---|---|");
for (const a of [...aspsps].sort((x, y) => (x.name ?? "").localeCompare(y.name ?? ""))) {
  out(`| ${a.name ?? "?"} | ${(a.psu_types ?? []).join(", ")} | ${days(a.maximum_consent_validity)} | ${a.beta === true ? "ja" : "nej"} |`);
}
out();
out("Sandboxen listar testbanker. Om Skandia saknas här betyder det inte att Skandia saknas i produktion.");

const report = `${lines.join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(report);
