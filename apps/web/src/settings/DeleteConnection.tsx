// Radera en bankkoppling (#28, KK-11-A, KK-11-B, KK-32-A). Frågan säger vad som händer och hur mycket
// historik som raderas, och historiken är förvald att raderas. Kvittensen säger ärligt att Cloudflares
// återställningspunkter finns kvar i några dagar. Går det inte att återkalla hos banken ändras ingenting.
import { useState } from "react";
import { deleteJson, field } from "../api.ts";

export interface HistoryCounts {
  readonly accounts: number;
  readonly transactions: number;
  readonly splits: number;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("sv-SE")} ${n === 1 ? one : many}`;

export function describeHistory(h: HistoryCounts): string {
  return `${plural(h.accounts, "konto", "konton")}, ${plural(h.transactions, "transaktion", "transaktioner")} och ${plural(h.splits, "uppdelning", "uppdelningar")}`;
}

/** Kvittensen efter en lyckad radering, som text. */
function receipt(body: unknown): string {
  const deleted = field(body, "deleted");
  const days = field(body, "backup_expiry_days");
  if (deleted === null) return "Kopplingen är återkallad hos banken. Historiken finns kvar i Kronkoll.";
  const h = { accounts: Number(field(deleted, "accounts")) || 0, transactions: Number(field(deleted, "transactions")) || 0, splits: Number(field(deleted, "splits")) || 0 };
  const backup = typeof days === "number" ? ` Cloudflares återställningspunkter med den gamla datan förfaller inom ${String(days)} dagar.` : "";
  return `Kopplingen är raderad och återkallad hos banken. ${describeHistory(h).replace(/^./u, (c) => c.toUpperCase())} är borttagna.${backup}`;
}

export function DeleteConnection(props: { id: string; bank: string; history: HistoryCounts; onDeleted: (receipt: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [purge, setPurge] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await deleteJson(`/api/connections/${encodeURIComponent(props.id)}?purge=${String(purge)}`);
    setBusy(false);
    if (status === 200) props.onDeleted(receipt(body));
    else if (status === 502) setError("Det gick inte att återkalla kopplingen hos banken. Ingenting är raderat. Försök igen om en stund.");
    else setError("Det gick inte att radera kopplingen. Ingenting är raderat. Försök igen.");
  };

  if (!asking) {
    return (
      <p>
        <button type="button" className="danger" onClick={() => { setAsking(true); }}>
          Radera koppling
        </button>
      </p>
    );
  }
  return (
    <section className="card tx-editor" aria-label={`Radera ${props.bank}-koppling`}>
      <h2>Radera {props.bank}-kopplingen?</h2>
      <p>Sessionen hos Enable Banking återkallas, och Kronkoll kan inte längre läsa dina {props.bank}-konton.</p>
      <label>
        <input type="checkbox" checked={purge} onChange={(e) => { setPurge(e.target.checked); }} /> Radera även historik: {describeHistory(props.history)}
      </label>
      <p>Regler, kategorier och budgetar behålls.</p>
      {error && <p role="alert">{error}</p>}
      <p>
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
          {busy ? "Raderar…" : purge ? "Radera permanent" : "Återkalla"}
        </button>
        <button type="button" disabled={busy} onClick={() => { setAsking(false); }}>
          Avbryt
        </button>
      </p>
    </section>
  );
}
