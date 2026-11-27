// Egna namn på konton (#34, KK-37), om kontot räknas med (KK-41-A) och om det är ett sparkonto (KK-52). Varje konto visar sitt namn och, under, bankens maskerade namn och
// banken, så att det går att känna igen. Namnet är användarens text och renderas som text (KK-37-C).
import { Pencil } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { field, getJson, patchJson } from "../api.ts";
import { IconButton } from "../icon-button.tsx";

/** Samma gräns som API:t. */
const MAX_LENGTH = 40;

interface Account {
  readonly id: string;
  readonly name: string;
  readonly nickname: string | null;
  readonly bankName: string;
  readonly bank: string | null;
  /** Kontot räknas med i budget, översikt och insikter. Saknas fältet räknas det med. */
  readonly counted: boolean;
  /** Sparkonto: överföringar dit räknas som sparande (KK-52). */
  readonly saving: boolean;
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
    counted: field(raw, "counted") !== false,
    saving: field(raw, "saving") === true,
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
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // Valet sparas först och visas när servern har svarat, eftersom det räknar om överföringarna (KK-41-D).
  const setChoice = async (id: string, change: { counted: boolean } | { saving: boolean }) => {
    setSaving(id);
    setError(null);
    const { status } = await patchJson(`/api/accounts/${encodeURIComponent(id)}`, change);
    setSaving(null);
    if (status !== 200) {
      setError("Det gick inte att spara. Försök igen.");
      return;
    }
    setState((current) => (current.kind === "ready" ? { kind: "ready", accounts: current.accounts.map((a) => (a.id === id ? { ...a, ...change } : a)) } : current));
  };

  return (
    <>
    {error && <p role="alert">{error}</p>}
    <ul aria-label="Konton">
      {state.accounts.map((a) => {
        // Under ett eget namn står bankens namn, så att kontot går att känna igen.
        const notes = [a.nickname === null ? null : a.bankName, a.bank].filter((s) => s !== null).join(" · ");
        return (
        <li key={a.id} className="tx">
          <div className="tx-main">
            <span className="tx-name">{a.name}</span>
            {editing !== a.id && <IconButton label={`Byt namn på ${a.name}`} icon={Pencil} onClick={() => { setEditing(a.id); }} />}
          </div>
          {notes !== "" && <small className="tx-notes">{notes}</small>}
          <label className="account-counted">
            <span>Räknas med</span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              aria-label={`Räknas med: ${a.name}`}
              checked={a.counted}
              disabled={saving !== null}
              onChange={(e) => void setChoice(a.id, { counted: e.target.checked })}
            />
          </label>
          {a.counted && (
            <label className="account-counted">
              <span>Sparkonto</span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                aria-label={`Sparkonto: ${a.name}`}
                checked={a.saving}
                disabled={saving !== null}
                onChange={(e) => void setChoice(a.id, { saving: e.target.checked })}
              />
            </label>
          )}
          {a.counted && a.saving && <small className="tx-notes">Överföringar hit räknas som sparande och uttag härifrån som inkomst.</small>}
          {!a.counted && <small className="tx-notes">Syns inte någonstans. Överföringar dit räknas som utgifter och överföringar därifrån som inkomster.</small>}
          {editing === a.id && <NameForm account={a} onSaved={(nickname) => { saved(a.id, nickname); }} onClose={() => { setEditing(null); }} />}
        </li>
        );
      })}
    </ul>
    </>
  );
}
