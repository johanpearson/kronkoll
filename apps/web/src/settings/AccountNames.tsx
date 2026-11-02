// Egna namn på konton (#34, KK-37). Varje konto visar sitt namn och, under, bankens maskerade namn och
// banken, så att det går att känna igen. Namnet är användarens text och renderas som text (KK-37-C).
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { field, getJson, patchJson } from "../api.ts";

/** Samma gräns som API:t. */
const MAX_LENGTH = 40;

interface Account {
  readonly id: string;
  readonly name: string;
  readonly nickname: string | null;
  readonly bankName: string;
  readonly bank: string | null;
}

function toAccount(raw: unknown): Account | null {
  const id = field(raw, "id");
  const bankName = field(raw, "bank_name");
  if (typeof id !== "string" || typeof bankName !== "string") return null;
  const nickname = field(raw, "nickname");
  const bank = field(raw, "bank");
  return {
    id,
    bankName,
    nickname: typeof nickname === "string" ? nickname : null,
    name: typeof nickname === "string" ? nickname : bankName,
    bank: typeof bank === "string" ? bank : null,
  };
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly accounts: readonly Account[] };

function NameForm(props: { account: Account; onSaved: (nickname: string | null) => void; onClose: () => void }) {
  const [value, setValue] = useState(props.account.nickname ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Fältet får fokus när formuläret öppnas, så att det går att skriva direkt.
  useEffect(() => {
    input.current?.focus();
  }, []);

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const { status, body } = await patchJson(`/api/accounts/${encodeURIComponent(props.account.id)}`, { nickname: value.trim() === "" ? null : value });
    setBusy(false);
    const nickname = field(body, "nickname");
    if (status === 200) props.onSaved(typeof nickname === "string" ? nickname : null);
    else setError(status === 400 ? "Namnet får vara högst 40 tecken och inte innehålla radbrytningar." : "Det gick inte att spara namnet. Försök igen.");
  };

  return (
    <form className="tx-editor" aria-label={`Namn på ${props.account.bankName}`} onSubmit={(e) => void save(e)}>
      <label>
        Namn
        <input ref={input} value={value} maxLength={MAX_LENGTH} placeholder={props.account.bankName} onChange={(e) => { setValue(e.target.value); }} />
      </label>
      <small>Lämna tomt för bankens namn.</small>
      {error && <p role="alert">{error}</p>}
      <p>
        <button type="submit" className="primary small" disabled={busy}>
          Spara
        </button>
        <button type="button" className="small" onClick={props.onClose}>
          Avbryt
        </button>
      </p>
    </form>
  );
}

export function AccountNames() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void getJson("/api/accounts").then(({ status, body }) => {
      if (!current) return;
      const items = field(body, "items");
      setState(status === 200 && Array.isArray(items) ? { kind: "ready", accounts: items.map(toAccount).filter((a): a is Account => a !== null) } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, []);

  if (state.kind === "loading") return <p>Hämtar…</p>;
  if (state.kind === "error") return <p role="alert">Det gick inte att hämta kontona. Försök igen om en stund.</p>;
  if (state.accounts.length === 0) return <p>Inga konton än. Koppla en bank först.</p>;

  const saved = (id: string, nickname: string | null) => {
    setState({ kind: "ready", accounts: state.accounts.map((a) => (a.id === id ? { ...a, nickname, name: nickname ?? a.bankName } : a)) });
    setEditing(null);
  };

  return (
    <ul aria-label="Konton">
      {state.accounts.map((a) => {
        // Under ett eget namn står bankens namn, så att kontot går att känna igen.
        const notes = [a.nickname === null ? null : a.bankName, a.bank].filter((s) => s !== null).join(" · ");
        return (
        <li key={a.id} className="tx">
          <div className="tx-main">
            <span className="tx-name">{a.name}</span>
            {editing !== a.id && (
              <button type="button" className="small" aria-label={`Byt namn på ${a.name}`} onClick={() => { setEditing(a.id); }}>
                Byt namn
              </button>
            )}
          </div>
          {notes !== "" && <small className="tx-notes">{notes}</small>}
          {editing === a.id && <NameForm account={a} onSaved={(nickname) => { saved(a.id, nickname); }} onClose={() => { setEditing(null); }} />}
        </li>
        );
      })}
    </ul>
  );
}
