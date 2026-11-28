// Kända konton (#249, KK-54): konton som inte är kopplade till appen, t.ex. en partners, som överföringar går till. Skandia
// skickar ingen motpart, så en överföring känns igen på texten i meddelandet. Ett konto har ett namn, matchningstexter (en per
// rad, Innehåller) och en standardkategori. Medan man skriver visas hur många transaktioner texterna träffar, innan något
// sparas (KK-54-A). Sparas ett konto kopplas hela historiken om. Namn och texter är användarens och renderas som text (KK-30).
import { Plus, Users } from "lucide-react";
import { useCallback, useEffect, useId, useState, type SyntheticEvent } from "react";
import { deleteJson, field, getJson, postJson, putJson } from "../api.ts";
import { useToast } from "../toast.tsx";
import { fetchCategories, NO_CATEGORIES, type Categories } from "../transactions/TransactionsView.tsx";
import { Button } from "../ui/Button.tsx";
import { List, ListRow } from "../ui/ListRow.tsx";
import { Sheet } from "../ui/Modal.tsx";
import { EmptyState, Skeleton } from "../ui/Surface.tsx";

/** Samma gränser som API:t. */
const MAX_PATTERNS = 10;
const MAX_PATTERN_LENGTH = 60;
/** Så länge efter senaste tecknet som förhandsvisningen väntar, så att den inte frågar för varje tangent. */
export const PREVIEW_DELAY_MS = 300;

export interface KnownAccount {
  readonly id: string;
  readonly name: string;
  readonly patterns: readonly string[];
  readonly categoryId: string | null;
}

function toAccount(raw: unknown): KnownAccount | null {
  const id = field(raw, "id");
  const name = field(raw, "name");
  const patterns = field(raw, "match_patterns");
  if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(patterns)) return null;
  const category = field(raw, "category_id");
  return { id, name, patterns: patterns.filter((p): p is string => typeof p === "string"), categoryId: typeof category === "string" ? category : null };
}

/** Kontona, eller null om de inte gick att hämta. Delas med kopplingen på en transaktion. */
export async function fetchKnownAccounts(): Promise<KnownAccount[] | null> {
  const { status, body } = await getJson("/api/known-accounts");
  const list = field(body, "known_accounts");
  return status === 200 && Array.isArray(list) ? list.map(toAccount).filter((a): a is KnownAccount => a !== null) : null;
}

/** En text per rad, utan tomma rader. */
const linesOf = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");

const hits = (count: number) => (count === 0 ? "Inga transaktioner träffar." : count === 1 ? "1 transaktion träffar." : `${String(count)} transaktioner träffar.`);

function AccountForm(props: { account: KnownAccount | null; categories: Categories; onSaved: (message: string) => void; onClose: () => void }) {
  const a = props.account;
  const nameId = useId();
  const textsId = useId();
  const categoryFieldId = useId();
  const [name, setName] = useState(a?.name ?? "");
  const [texts, setTexts] = useState((a?.patterns ?? []).join("\n"));
  const [categoryId, setCategoryId] = useState(a?.categoryId ?? "");
  const [count, setCount] = useState<number | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const list = linesOf(texts);
  const tooMany = list.length > MAX_PATTERNS || list.some((p) => p.length > MAX_PATTERN_LENGTH);

  // Förhandsvisar texterna en stund efter senaste ändringen, och struntar i svar som kommer för sent.
  const accountId = a?.id;
  useEffect(() => {
    const patterns = linesOf(texts);
    if (patterns.length === 0 || patterns.length > MAX_PATTERNS || patterns.some((p) => p.length > MAX_PATTERN_LENGTH)) {
      setCount(null);
      setPreviewFailed(false);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void postJson("/api/known-accounts/preview", { ...(accountId === undefined ? {} : { id: accountId }), match_patterns: patterns }).then(({ status, body }) => {
        if (!current) return;
        const n = field(body, "count");
        setCount(status === 200 && typeof n === "number" ? n : null);
        setPreviewFailed(!(status === 200 && typeof n === "number"));
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [texts, accountId]);

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem =
      name.trim() === ""
        ? "Ge kontot ett namn, till exempel Kontot A."
        : list.length === 0
          ? "Skriv minst en text som överföringarna innehåller."
          : tooMany
            ? "Skriv högst tio texter, var och en på högst 60 tecken."
            : categoryId === ""
              ? "Välj en kategori."
              : null;
    setError(problem);
    if (problem !== null) return;
    setBusy(true);
    const id = a?.id ?? crypto.randomUUID();
    const { status, body } = await putJson(`/api/known-accounts/${encodeURIComponent(id)}`, { name: name.trim(), match_patterns: list, category_id: categoryId });
    setBusy(false);
    if (status !== 200 && status !== 201) {
      setError(status === 400 ? "Kontrollera namn, texter och kategori." : "Det gick inte att spara kontot. Försök igen.");
      return;
    }
    const linked = field(body, "linked");
    const saved = status === 201 ? "Kontot är sparat." : "Kontot är ändrat.";
    props.onSaved(typeof linked === "number" && linked > 0 ? `${saved} ${String(linked)} ${linked === 1 ? "överföring kopplades om" : "överföringar kopplades om"}.` : saved);
  };

  const remove = async () => {
    if (!a) return;
    setBusy(true);
    const { status } = await deleteJson(`/api/known-accounts/${encodeURIComponent(a.id)}`);
    setBusy(false);
    if (status === 204) props.onSaved("Kontot är borttaget.");
    else {
      setConfirming(false);
      setError("Det gick inte att ta bort kontot. Försök igen.");
    }
  };

  return (
    <form className="ui-stack" aria-label={a ? `Ändra ${a.name}` : "Nytt känt konto"} onSubmit={(e) => void save(e)}>
      <div className="ui-field">
        <label htmlFor={nameId} className="ui-label">
          Namn
        </label>
        <input id={nameId} data-autofocus className="ui-input" value={name} maxLength={60} onChange={(e) => { setName(e.target.value); }} />
      </div>
      <div className="ui-field">
        <label htmlFor={textsId} className="ui-label">
          Texter i meddelandet
        </label>
        <textarea id={textsId} className="ui-input" rows={3} value={texts} aria-describedby={`${textsId}-hint`} onChange={(e) => { setTexts(e.target.value); }} />
        <p id={`${textsId}-hint`} className="ui-caption">
          En text per rad. Överföringar vars meddelande innehåller texten, oavsett versaler, hör till kontot. Skriv inte kontonummer om du inte vill spara dem.
        </p>
      </div>
      <div className="ui-field">
        <label htmlFor={categoryFieldId} className="ui-label">
          Standardkategori
        </label>
        <select id={categoryFieldId} className="ui-input" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); }}>
          <option value="">Välj kategori</option>
          {props.categories.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div aria-live="polite">
        {count !== null && <p className="ui-body">{hits(count)}</p>}
        {previewFailed && <p className="ui-caption">Det gick inte att räkna träffarna. Du kan ändå spara kontot.</p>}
      </div>
      {error && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      {confirming ? (
        <div className="ui-stack">
          <p className="ui-body">Ta bort kontot? Överföringarna kopplas loss och får kategorier av reglerna. Inget hos banken ändras.</p>
          <Button variant="danger" block busy={busy} onClick={() => void remove()}>
            Ta bort
          </Button>
          <Button variant="quiet" block onClick={() => { setConfirming(false); }}>
            Behåll
          </Button>
        </div>
      ) : (
        <>
          <Button type="submit" variant="primary" block busy={busy}>
            Spara
          </Button>
          <Button variant="quiet" block onClick={props.onClose}>
            Avbryt
          </Button>
          {a && (
            <Button variant="danger" block onClick={() => { setConfirming(true); }}>
              Ta bort
            </Button>
          )}
        </>
      )}
    </form>
  );
}

/** Arket: ett nytt konto (null) eller ett som ändras. */
type Editing = { readonly account: KnownAccount | null } | null;

export function KnownAccountsView() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<KnownAccount[] | null | "error">(null);
  const [categories, setCategories] = useState<Categories>(NO_CATEGORIES);
  const [editing, setEditing] = useState<Editing>(null);

  const load = useCallback(async () => {
    setAccounts((await fetchKnownAccounts()) ?? "error");
  }, []);
  useEffect(() => {
    void load();
    void fetchCategories().then(setCategories);
  }, [load]);

  if (accounts === null) return <main><h1>Kända konton</h1><Skeleton lines={4} /></main>;
  if (accounts === "error") return <main><h1>Kända konton</h1><p role="alert">Det gick inte att hämta kontona. Försök igen om en stund.</p></main>;

  const add = (
    <Button variant="primary" block icon={Plus} onClick={() => { setEditing({ account: null }); }}>
      Lägg till konto
    </Button>
  );
  const close = () => { setEditing(null); };
  return (
    <main>
      <h1>Kända konton</h1>
      <p className="ui-body">Lägg till konton som inte är kopplade till appen, till exempel en partners. Överföringar dit känns igen på texten i meddelandet, visas med kontots namn och får en kategori, till exempel en för privat ekonomi eller sparande. Det du själv har valt ändras aldrig.</p>
      {accounts.length === 0 ? (
        <EmptyState title="Inga kända konton" icon={Users} action={add}>
          Du har inte lagt till något än.
        </EmptyState>
      ) : (
        <>
          {add}
          <List label="Kända konton">
            {accounts.map((a) => (
              <ListRow
                key={a.id}
                label={a.name}
                detail={`${a.patterns.join(", ")} → ${a.categoryId === null ? "Ingen kategori" : (categories.names.get(a.categoryId) ?? a.categoryId)}`}
                onClick={() => { setEditing({ account: a }); }}
              />
            ))}
          </List>
        </>
      )}
      <Sheet open={editing !== null} title={editing?.account ? `Ändra ${editing.account.name}` : "Nytt känt konto"} onClose={close}>
        {editing && (
          <AccountForm
            account={editing.account}
            categories={categories}
            onSaved={(message) => {
              toast.done(message);
              setEditing(null);
              void load();
            }}
            onClose={close}
          />
        )}
      </Sheet>
    </main>
  );
}
