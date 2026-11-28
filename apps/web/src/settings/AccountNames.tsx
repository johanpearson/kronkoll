// Egna namn på konton (#34, KK-37) och kontots roll (KK-53): Inkomst/Utgift, Buffert eller Uteslutet. Varje
// konto visar sitt namn och, under, bankens maskerade namn och banken, så att det går att känna igen. Namnet är användarens text och renderas som text (KK-37-C).
import { Pencil } from "lucide-react";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { field, getJson, patchJson } from "../api.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Sheet } from "../ui/Modal.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Card, EmptyState, Skeleton } from "../ui/Surface.tsx";

/** Samma gräns som API:t. */
const MAX_LENGTH = 40;

type Role = "spending" | "buffer" | "excluded";

const ROLES: readonly { value: Role; label: string }[] = [
  { value: "spending", label: "Inkomst/Utgift" },
  { value: "buffer", label: "Buffert" },
  { value: "excluded", label: "Uteslutet" },
];

/** Vad rollen betyder, i en mening under valet (KK-53-A). */
const EXPLAINED: Record<Role, string> = {
  spending: "Lön och utgifter. Överföringar mellan sådana konton räknas inte.",
  buffer: "Sparande. Överföringar hit räknas som sparande och uttag härifrån som uttag från sparande.",
  excluded: "Syns inte någonstans. Överföringar dit räknas som utgifter och överföringar därifrån som inkomster.",
};

const isRole = (value: unknown): value is Role => value === "spending" || value === "buffer" || value === "excluded";

interface Account {
  readonly id: string;
  readonly name: string;
  readonly nickname: string | null;
  readonly bankName: string;
  readonly bank: string | null;
  readonly role: Role;
}

/** Rollen från API:t, Inkomst/Utgift om den saknas eller är okänd. */
function roleOf(raw: unknown): Role {
  const role = field(raw, "role");
  return isRole(role) ? role : "spending";
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
    role: roleOf(raw),
  };
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly accounts: readonly Account[] };

/** Byt namn i ett ark (#259): fältet får fokus direkt, och felet visas vid fältet. */
function NameForm(props: { account: Account; onSaved: (nickname: string | null) => void; onClose: () => void }) {
  const [value, setValue] = useState(props.account.nickname ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  // Fältet får fokus när arket öppnas, så att det går att skriva direkt.
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
    <form className="ui-stack" aria-label={`Namn på ${props.account.bankName}`} onSubmit={(e) => void save(e)}>
      <div className="ui-field">
        <label htmlFor={id} className="ui-label">
          Namn
        </label>
        <input id={id} ref={input} data-autofocus className="ui-input" value={value} maxLength={MAX_LENGTH} placeholder={props.account.bankName} onChange={(e) => { setValue(e.target.value); }} />
        {error ? (
          <p role="alert" className="ui-field-error">
            {error}
          </p>
        ) : (
          <p className="ui-caption">Lämna tomt för bankens namn.</p>
        )}
      </div>
      <Button type="submit" variant="primary" block busy={busy}>
        Spara
      </Button>
      <Button variant="quiet" block onClick={props.onClose}>
        Avbryt
      </Button>
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

  if (state.kind === "loading") return <Skeleton lines={3} />;
  if (state.kind === "error") return <p role="alert">Det gick inte att hämta kontona. Försök igen om en stund.</p>;
  if (state.accounts.length === 0) return <EmptyState title="Inga konton än">Inga konton än. Koppla en bank först.</EmptyState>;

  const saved = (id: string, nickname: string | null) => {
    setState({ kind: "ready", accounts: state.accounts.map((a) => (a.id === id ? { ...a, nickname, name: nickname ?? a.bankName } : a)) });
    setEditing(null);
  };

  // Valet sparas först och visas när servern har svarat, eftersom det räknar om överföringarna (KK-53-A).
  const setRole = async (id: string, role: Role) => {
    setSaving(id);
    setError(null);
    const { status } = await patchJson(`/api/accounts/${encodeURIComponent(id)}`, { role });
    setSaving(null);
    if (status !== 200) {
      setError("Det gick inte att spara. Försök igen.");
      return;
    }
    setState((current) => (current.kind === "ready" ? { kind: "ready", accounts: current.accounts.map((a) => (a.id === id ? { ...a, role } : a)) } : current));
  };

  const renaming = state.accounts.find((a) => a.id === editing);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <ul className="account-list" aria-label="Konton">
        {state.accounts.map((a) => {
          // Under ett eget namn står bankens namn, så att kontot går att känna igen.
          const notes = [a.nickname === null ? null : a.bankName, a.bank].filter((s) => s !== null).join(" · ");
          return (
            <li key={a.id}>
              <Card title={a.name} action={<IconButton label={`Byt namn på ${a.name}`} icon={Pencil} onClick={() => { setEditing(a.id); }} />}>
                {notes !== "" && <p className="ui-caption account-bank">{notes}</p>}
                <SegmentedControl
                  label={`Roll för ${a.name}`}
                  options={ROLES}
                  value={a.role}
                  onChange={(role) => {
                    if (saving === null && role !== a.role) void setRole(a.id, role);
                  }}
                />
                <p className="ui-caption">{EXPLAINED[a.role]}</p>
              </Card>
            </li>
          );
        })}
      </ul>
      <Sheet open={renaming !== undefined} title="Byt namn" onClose={() => { setEditing(null); }}>
        {renaming && <NameForm account={renaming} onSaved={(nickname) => { saved(renaming.id, nickname); }} onClose={() => { setEditing(null); }} />}
      </Sheet>
    </>
  );
}
