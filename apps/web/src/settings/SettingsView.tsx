// Inställningar (#34, KK-35). Första versionen har bara det som behövs nu: att koppla en bank och att
// logga ut och rensa enheten. Bankkopplingar, kategorier och budgetperiod kommer med #34.
import { useState } from "react";
import { browser } from "../browser.ts";
import { Link } from "../router.tsx";

/** Cloudflare Access utloggning på samma adress som appen. */
const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

export function SettingsView() {
  const [busy, setBusy] = useState(false);

  const logOut = async () => {
    setBusy(true);
    await browser.clearDevice();
    browser.assign(ACCESS_LOGOUT);
  };

  return (
    <main>
      <h1>Inställningar</h1>
      <h2>Bank</h2>
      <p>
        <Link to="/koppla">Koppla bank</Link>
      </p>
      <h2>Den här enheten</h2>
      <p>Utloggningen tar bort allt Kronkoll har sparat i webbläsaren och avslutar inloggningen.</p>
      <button type="button" disabled={busy} onClick={() => void logOut()}>
        {busy ? "Loggar ut…" : "Logga ut och rensa enheten"}
      </button>
    </main>
  );
}
