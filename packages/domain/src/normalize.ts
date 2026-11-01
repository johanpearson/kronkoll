/**
 * Normalisering av motpart (F-learn). Bankens motpartstext varierar mellan köp i samma butik:
 * kortprefix, butiksnummer och ort. Normaliseringen tar bort det, så att regler och insikter
 * kan känna igen samma motpart. Banktexten är opålitlig indata och behandlas bara som text (KK-30).
 */

/** Prefix som betalförmedlare lägger före butikens namn, t.ex. "K*ICA", "SQ *KAFFEBAREN". */
const PROCESSOR_PREFIX = /^(?:K\s?\*|SQ\s?\*|PAYPAL\s?\*|IZ\s?\*|ZETTLE\s?_?\*|SUMUP\s?\*|KLARNA\s?\*)\s*/u;

/** Tokens som bara är nummer, t.ex. butiksnummer "4711" eller "#123". */
const NUMBER_TOKEN = /^#?\d[\d./-]*$/u;

/** Orter och landskoder som ofta står sist i motpartstexten. */
const TRAILING_PLACES = new Set([
  "SE", "SWE", "SVERIGE", "STHLM", "STOCKHOLM", "GBG", "GOTEBORG", "GÖTEBORG", "MALMO", "MALMÖ",
  "UPPSALA", "LINKOPING", "LINKÖPING", "OREBRO", "ÖREBRO", "VASTERAS", "VÄSTERÅS",
  "HELSINGBORG", "NORRKOPING", "NORRKÖPING", "JONKOPING", "JÖNKÖPING", "UMEA", "UMEÅ", "LUND",
  "SOLNA", "SUNDBYBERG", "NACKA", "HUDDINGE",
]);

export function normalizeCounterparty(raw: string): string {
  const upper = raw.toLocaleUpperCase("sv-SE").replace(/\s+/gu, " ").trim();
  const tokens = upper.replace(PROCESSOR_PREFIX, "").split(" ").filter((t) => t !== "" && !NUMBER_TOKEN.test(t));
  // Ta bort orter i slutet, men aldrig det första ordet: det är butikens namn.
  while (tokens.length > 1 && TRAILING_PLACES.has(tokens[tokens.length - 1] ?? "")) tokens.pop();
  return tokens.join(" ");
}

/** Mönstret som lärs in när användaren väljer "Gör alltid så": första ordet, t.ex. "ICA". */
export function learnPattern(counterpartyNorm: string): string | null {
  const first = counterpartyNorm.split(" ")[0] ?? "";
  return first === "" ? null : first;
}

/** Sant om värdet börjar med mönstret som hela ord: "ICA" matchar "ICA KVANTUM" men inte "ICAROS". */
export function matchesWordPrefix(pattern: string, value: string): boolean {
  if (pattern === "") return false;
  return value === pattern || value.startsWith(`${pattern} `);
}
