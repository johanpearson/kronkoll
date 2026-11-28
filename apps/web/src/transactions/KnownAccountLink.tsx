// Det kända konto en överföring hör till (KK-54-B, KK-54-C): "Till: <namn>" på detaljsidan, och knappar för att koppla till ett
// känt konto eller koppla loss för hand med PUT /api/transactions/{id}/known-account. En koppling för hand ändras aldrig av
// kontots texter. Valfritt läggs överföringens text till som ny matchningstext. Namnet är användarens text och renderas som text (KK-30).
import { useState } from "react";
import { field, putJson } from "../api.ts";
import { fetchKnownAccounts } from "../settings/KnownAccountsView.tsx";
import { useToast } from "../toast.tsx";

export interface LinkedKnownAccount {
  readonly id: string;
  readonly name: string;
  readonly source: "auto" | "manual";
}

/** Kontot ur transaktionens detalj, eller null utan koppling. */
export function toLinkedKnownAccount(raw: unknown): LinkedKnownAccount | null {
  const id = field(raw, "id");
  const name = field(raw, "name");
  if (typeof id !== "string" || typeof name !== "string") return null;
  return { id, name, source: field(raw, "source") === "manual" ? "manual" : "auto" };
}

/** "Kontot A (vald av dig)" eller "Kontot A (automatiskt)". */
export const knownAccountLabel = (account: LinkedKnownAccount) => `${account.name} (${account.source === "manual" ? "vald av dig" : "automatiskt"})`;

export function KnownAccountLink(props: { transactionId: string; account: LinkedKnownAccount | null; onSaved: () => void }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<readonly { id: string; name: string }[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [addText, setAddText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (id: string | null) => {
    setBusy(true);
    setError(null);
    const { status } = await putJson(`/api/transactions/${encodeURIComponent(props.transactionId)}/known-account`, {
      known_account_id: id,
      ...(id !== null && addText ? { add_pattern: true } : {}),
    });
    setBusy(false);
    if (status !== 200) {
      setError("Det gick inte att spara kopplingen. Försök igen.");
      return;
    }
    toast.done(id === null ? "Överföringen är kopplad loss från kontot." : "Överföringen är kopplad till kontot.");
    setAccounts(null);
    setAddText(false);
    props.onSaved();
  };

  const choose = async () => {
    setError(null);
    const list = await fetchKnownAccounts();
    if (list === null) {
      setError("Det gick inte att hämta kontona. Försök igen.");
      return;
    }
    setAccounts(list.map((a) => ({ id: a.id, name: a.name })));
    setChosen(list[0]?.id ?? "");
  };

  return (
    <section className="card" aria-label="Känt konto">
      {error && <p role="alert">{error}</p>}
      {props.account ? (
        <p className="actions">
          <button type="button" disabled={busy} onClick={() => void save(null)}>
            Koppla loss från kontot
          </button>
        </p>
      ) : accounts === null ? (
        <p className="actions">
          <button type="button" disabled={busy} onClick={() => void choose()}>
            Koppla till känt konto
          </button>
        </p>
      ) : accounts.length === 0 ? (
        <p>Lägg till kontot under Inställningar › Kända konton först.</p>
      ) : (
        <div className="ui-stack">
          <p className="actions">
            <label>
              Känt konto
              <select value={chosen} onChange={(e) => { setChosen(e.target.value); }}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <label>
            <input type="checkbox" checked={addText} onChange={(e) => { setAddText(e.target.checked); }} /> Lägg till överföringens text som matchningstext, så att fler känns igen
          </label>
          <p className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void save(chosen)}>
              Koppla
            </button>
            <button type="button" onClick={() => { setAccounts(null); }}>
              Avbryt
            </button>
          </p>
        </div>
      )}
    </section>
  );
}
