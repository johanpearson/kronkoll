// Förnya samtycket (#27, KK-8): startar BankID igen för samma bank och samma koppling. Banken skickar
// tillbaka till /koppla/klar, som förnyar kopplingen. Konton och historik finns kvar.
import { useState } from "react";
import { field, postJson } from "../api.ts";
import { browser } from "../browser.ts";

export function RenewConnection(props: { id: string; urgent: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await postJson(`/api/connections/${encodeURIComponent(props.id)}/renew`, {});
    const url = field(body, "redirect_url");
    if (status === 200 && typeof url === "string" && url.startsWith("https://")) {
      browser.assign(url);
      return;
    }
    setError(status === 502 ? "Banken svarade inte. Försök igen om en stund." : "Det gick inte att starta förnyelsen. Försök igen.");
    setBusy(false);
  };

  return (
    <>
      <p>
        <button type="button" className={props.urgent ? "primary" : undefined} disabled={busy} onClick={() => void start()}>
          {busy ? "Startar…" : "Förnya med BankID"}
        </button>
      </p>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
