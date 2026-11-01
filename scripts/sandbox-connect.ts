// Kopplar Enable Bankings sandbox, så att kontraktstestet kan köras varje natt (#24, V-c-provider).
// Körs från workflowen sandbox-connect i två steg:
//   start:  skapar en auktorisering och skriver inloggningslänken i körningens sammanfattning.
//   finish: tar adressen som webbläsaren hamnade på efter godkännandet, byter koden mot en
//           session och skriver session-id:t till filen i SESSION_OUT (bara på runnern).
// Bara sandbox-nyckeln används. Ingen nyckel, token eller session skrivs någonsin ut (KK-12, KK-13).
import { appendFileSync, writeFileSync } from "node:fs";
import { createJwtSigner } from "../packages/adapter-enablebanking/src/jwt.ts";

const api = process.env.EB_API_URL ?? "https://api.enablebanking.com";
const step = process.env.STEP ?? "";
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const REDIRECT_URL = "https://kronkoll-25e.pages.dev/koppla/klar";
const CONSENT_DAYS = 90;

const signer = createJwtSigner({
  applicationId: process.env.EB_APP_ID ?? "",
  privateKeyPem: process.env.EB_PRIVATE_KEY ?? "",
  now: () => Date.now(),
});

function summary(lines: string[]): void {
  const text = `${lines.join("\n")}\n`;
  if (summaryFile) appendFileSync(summaryFile, text);
  else process.stdout.write(text);
}

/** Felkod och status från Enable Banking, aldrig svarstexten i övrigt. */
async function call(method: "GET" | "POST", path: string, body?: object): Promise<Record<string, unknown>> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${await signer.sign()}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path} svarade ${String(res.status)} (${typeof json.code === "string" ? json.code : "ingen kod"})`);
  return json;
}

if (step === "start") {
  const name = process.env.EB_ASPSP ?? "Mock ASPSP";
  const country = process.env.EB_COUNTRY ?? "FI";
  const validUntil = new Date(Date.now() + CONSENT_DAYS * 86_400_000).toISOString();
  const auth = await call("POST", "/auth", {
    access: { valid_until: validUntil },
    aspsp: { name, country },
    state: crypto.randomUUID(),
    redirect_url: REDIRECT_URL,
    psu_type: "personal",
  });
  if (typeof auth.url !== "string" || !auth.url.startsWith("https://")) throw new Error("Svaret saknade en inloggningslänk");
  summary([
    "## Koppla sandboxen, steg 1 av 2",
    "",
    `1. Öppna länken och godkänn hos testbanken **${name}** (${country}). Det är påhittad data.`,
    `2. Du hamnar på \`${REDIRECT_URL}?code=…\`. Kopiera **hela adressen** från adressfältet.`,
    "3. Kör workflowen **sandbox-connect** igen med steget `finish` och klistra in adressen.",
    "",
    `**[Öppna testbanken](${auth.url})**`,
    "",
    `Samtycket gäller i ${String(CONSENT_DAYS)} dagar.`,
  ]);
} else if (step === "finish") {
  const redirect = process.env.REDIRECTED_TO ?? "";
  let code: string | null = null;
  try {
    const url = new URL(redirect.trim());
    if (url.origin === new URL(REDIRECT_URL).origin) code = url.searchParams.get("code");
  } catch {
    // Hanteras nedan
  }
  if (!code) throw new Error(`Adressen måste börja med ${REDIRECT_URL} och innehålla ?code=`);
  const session = await call("POST", "/sessions", { code });
  if (typeof session.session_id !== "string") throw new Error("Svaret saknade session-id");
  const out = process.env.SESSION_OUT;
  if (!out) throw new Error("SESSION_OUT saknas");
  writeFileSync(out, session.session_id, { mode: 0o600 });
  const accounts = Array.isArray(session.accounts) ? session.accounts.length : 0;
  summary(["## Koppla sandboxen, steg 2 av 2", "", `Klart. Sessionen har **${String(accounts)}** konton och sparas som secret i miljön \`sandbox\`.`]);
} else {
  throw new Error("STEP måste vara start eller finish");
}
