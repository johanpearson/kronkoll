// Vyerna för att koppla en bank (#26, flödet F-koppla): välj bank, godkänn läsbehörigheten och
// kom tillbaka från banken. BankID sköts helt hos banken. Appen ser bara koden och state som
// banken skickar tillbaka, och de lämnar adressfältet direkt.
import { useEffect, useRef, useState } from "react";
import { field, postJson } from "../api.ts";
import { browser } from "../browser.ts";
import { Link } from "../router.tsx";

/**
 * Bankerna som går att koppla. Namnet måste vara exakt Enable Bankings namn för banken.
 * SBAB är bortvald: bolånet syns inte via PSD2 och läggs in för hand (#72).
 * En lista från Enable Banking (GET /aspsps) kan ersätta den här senare.
 */
const BANKS = [{ name: "Skandia", subtitle: "Konton och kort" }] as const;

export function ConnectBank() {
  return (
    <main>
      <h1>Koppla bank</h1>
      <ul>
        {BANKS.map((bank) => (
          <li key={bank.name}>
            <Link to={`/koppla/samtycke?bank=${encodeURIComponent(bank.name)}`}>
              {bank.name} – {bank.subtitle}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

export function Consent() {
  const name = new URLSearchParams(window.location.search).get("bank");
  const bank = BANKS.find((b) => b.name === name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!bank) {
    return (
      <main>
        <h1>Godkänn läsbehörighet</h1>
        <p>Banken finns inte i listan.</p>
        <Link to="/koppla">Välj bank</Link>
      </main>
    );
  }

  const start = async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await postJson("/api/connections", { aspsp: { name: bank.name, country: "SE" } });
    const url = field(body, "redirect_url");
    if (status === 200 && typeof url === "string" && url.startsWith("https://")) {
      browser.assign(url);
      return;
    }
    setError(status === 502 ? "Banken svarade inte. Försök igen om en stund." : "Det gick inte att starta kopplingen. Försök igen.");
    setBusy(false);
  };

  return (
    <main>
      <h1>Godkänn läsbehörighet</h1>
      <h2>Kronkoll vill läsa från {bank.name}</h2>
      <ul>
        <li>Konton och saldon</li>
        <li>Transaktioner – så långt bakåt banken tillåter</li>
        <li>Inga betalningar eller överföringar – kan inte göras</li>
      </ul>
      <p>Samtycket gäller så länge banken tillåter. Du får en påminnelse innan det går ut, och du kan radera kopplingen när du vill.</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void start()}>
        {busy ? "Startar…" : "Fortsätt till BankID"}
      </button>
      <p>Du skickas till {bank.name} via Enable Banking och kommer tillbaka hit.</p>
    </main>
  );
}

type DoneState = { kind: "working" } | { kind: "done"; accounts: number } | { kind: "error"; message: string };

const ABORTED = "Kopplingen avbröts hos banken. Inget sparades.";

export function ConnectDone() {
  const [state, setState] = useState<DoneState>({ kind: "working" });
  // Effekter kan köras två gånger i utvecklingsläge. Koden får bara användas en gång.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const stateParam = params.get("state");
    // Koden och state ska inte ligga kvar i adressfältet eller historiken.
    window.history.replaceState(null, "", window.location.pathname);
    if (params.has("error") || !code || !stateParam) {
      setState({ kind: "error", message: ABORTED });
      return;
    }
    void postJson("/api/connections/callback", { code, state: stateParam }).then(({ status, body }) => {
      const accounts = field(body, "accounts");
      if (status === 201) setState({ kind: "done", accounts: typeof accounts === "number" ? accounts : 0 });
      else if (status === 400 && field(body, "error") === "invalid_state")
        setState({ kind: "error", message: "Länken har gått ut eller redan använts. Börja om från början." });
      else setState({ kind: "error", message: "Det gick inte att göra klart kopplingen. Försök igen." });
    });
  }, []);

  if (state.kind === "working") {
    return (
      <main>
        <h1>Kopplar…</h1>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main>
        <h1>Koppla bank</h1>
        <p role="alert">{state.message}</p>
        <Link to="/koppla">Försök igen</Link>
      </main>
    );
  }
  return (
    <main>
      <h1>Kopplat! Hämtar historik…</h1>
      <p>{state.accounts === 1 ? "1 konto hittades." : `${String(state.accounts)} konton hittades.`}</p>
      <p>Transaktionerna hämtas i bakgrunden och syns om en liten stund.</p>
      <Link to="/">Till start</Link>
    </main>
  );
}
