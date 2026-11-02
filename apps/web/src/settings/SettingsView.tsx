// Inställningar (#34, KK-26-A, KK-35). Första versionen har det som behövs nu: koppla en bank, välja
// utseende och logga ut och rensa enheten. Bankkopplingar, kategorier och budgetperiod kommer med #34.
import { useState } from "react";
import { browser } from "../browser.ts";
import { Link } from "../router.tsx";
import { setTheme, storedTheme, type Theme } from "../theme.ts";

/** Cloudflare Access utloggning på samma adress som appen. */
const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "Som systemet" },
  { value: "light", label: "Ljust" },
  { value: "dark", label: "Mörkt" },
];

export function SettingsView() {
  const [busy, setBusy] = useState(false);
  const [theme, setChosen] = useState<Theme>(storedTheme);

  const logOut = async () => {
    setBusy(true);
    await browser.clearDevice();
    browser.assign(ACCESS_LOGOUT);
  };

  const choose = (value: Theme) => {
    setTheme(value);
    setChosen(value);
  };

  return (
    <main>
      <h1>Inställningar</h1>
      <h2>Bank</h2>
      <section className="card">
        <Link to="/koppla">Koppla bank</Link>
      </section>
      <h2 id="theme-heading">Utseende</h2>
      <section className="card">
        <div role="radiogroup" aria-labelledby="theme-heading" className="choices">
          {THEMES.map((t) => (
            <label key={t.value}>
              <input type="radio" name="theme" value={t.value} checked={theme === t.value} onChange={() => { choose(t.value); }} />
              {t.label}
            </label>
          ))}
        </div>
      </section>
      <h2>Den här enheten</h2>
      <section className="card">
        <p>Utloggningen tar bort allt Kronkoll har sparat i webbläsaren och avslutar inloggningen.</p>
        <button type="button" className="danger" disabled={busy} onClick={() => void logOut()}>
          {busy ? "Loggar ut…" : "Logga ut och rensa enheten"}
        </button>
      </section>
    </main>
  );
}
