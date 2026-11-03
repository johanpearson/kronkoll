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

/** "BUTIK, ORT" → "BUTIK". Står inget före kommatecknet behålls det som står efter. */
function withoutPlaceAfterComma(text: string): string {
  const comma = text.lastIndexOf(",");
  if (comma === -1) return text;
  const head = text.slice(0, comma);
  return head.trim() === "" ? text.slice(comma + 1) : head;
}

/**
 * "BUTIK*ORDERNUMMER" → "BUTIK". Näthandel som Amazon lägger ett nytt ordernummer efter stjärnan vid
 * varje köp. Körs efter att betalförmedlarens prefix ("K*", "PAYPAL *") har tagits bort.
 */
function withoutReference(text: string): string {
  const star = text.indexOf("*");
  return star > 0 ? text.slice(0, star) : text;
}

/**
 * Ord med siffror på flera ställen, t.ex. "BT4W355R4" eller "AB12CD34", är order- eller referenskoder som
 * är olika varje gång. De tas bort före uppdelningen nedan. Ett namn med ett butiksnummer, som
 * "WILLYS42ODENPLAN", har bara en sifferföljd och behålls.
 */
const withoutCodes = (text: string) =>
  text
    .split(" ")
    .filter((t) => (t.match(/\d+/gu)?.length ?? 0) < 2 || NUMBER_TOKEN.test(t))
    .join(" ");

export function normalizeCounterparty(raw: string): string {
  // Ordningen spelar roll: betalförmedlarens prefix före stjärnan, och stjärnan före koderna.
  const upper = withoutPlaceAfterComma(raw.toLocaleUpperCase("sv-SE")).replace(/\s+/gu, " ").trim();
  const tokens = withoutCodes(withoutReference(upper.replace(PROCESSOR_PREFIX, "")).trim())
    // Butiksnummer som sitter ihop med namnet, t.ex. "WILLYS42ODENPLAN", blir ett eget ord.
    .replace(/(\p{L})(\d)/gu, "$1 $2")
    .replace(/(\d)(\p{L})/gu, "$1 $2")
    .split(" ")
    .filter((t) => t !== "" && !NUMBER_TOKEN.test(t));
  // Ta bort orter i slutet, men aldrig det första ordet: det är butikens namn.
  while (tokens.length > 1 && TRAILING_PLACES.has(tokens[tokens.length - 1] ?? "")) tokens.pop();
  return tokens.join(" ");
}

/**
 * Mönstret som lärs in när användaren väljer "Gör alltid så": hela den normaliserade motparten, t.ex.
 * "ICA KVANTUM". Första ordet vore för brett ("SWISH", "MAX", "THE" slår ihop orelaterade motparter).
 * Regeln används som ordprefix, se matchesWordPrefix.
 */
export function learnPattern(counterpartyNorm: string): string | null {
  const pattern = counterpartyNorm.trim();
  return pattern === "" ? null : pattern;
}

/** Sant om värdet börjar med mönstret som hela ord: "ICA" matchar "ICA KVANTUM" men inte "ICAROS". */
export function matchesWordPrefix(pattern: string, value: string): boolean {
  if (pattern === "") return false;
  return value === pattern || value.startsWith(`${pattern} `);
}
