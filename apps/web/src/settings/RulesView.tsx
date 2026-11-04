// Regler (#34, KK-18-B, KK-18-C): alla kategoriseringsregler, med hur många transaktioner varje regel
// träffar. Lägg till en regel direkt ("allt som börjar med IKEA → Hushåll"), ändra eller ta bort. En ny
// eller ändrad regel gäller nya transaktioner direkt; för tidigare frågar vyn först. Manuellt valda
// ändras aldrig. En regel vars kategori är arkiverad markeras med text. "Visa träffar" och frågan efter
// att en regel sparats visar vilka transaktioner den gäller. "Applicera alla regler" kör alla regler över
// historiken efter en fråga, och Synka nu hämtar nytt från banken och kategoriserar.
// En regel kan också ha åtgärden Räkna inte (KK-39-C): den gäller hela historiken direkt, så vyn visar
// först hur många den träffar och sparar när användaren bekräftar. Egna val ändras aldrig.
import { useEffect, useState, type SyntheticEvent } from "react";
import { deleteJson, field, getJson, patchJson, postJson, type ApiResult } from "../api.ts";
import { Link } from "../router.tsx";
import { SyncButton } from "../sync/SyncButton.tsx";
import { useToast } from "../toast.tsx";
import { fetchCategories, NO_CATEGORIES, type Categories } from "../transactions/TransactionsView.tsx";
import { RuleMatches } from "./RuleMatches.tsx";

/** Värdet i kategorivalet som betyder Räkna inte i stället för en kategori. */
const EXCLUDE = "exclude";

interface Rule {
  readonly id: string;
  readonly pattern: string;
  /** Null för en Räkna inte-regel. */
  readonly categoryId: string | null;
  readonly exclude: boolean;
  readonly learned: boolean;
  readonly hits: number;
  readonly archived: boolean;
}

function toRule(raw: unknown): Rule | null {
  const id = field(raw, "id");
  const pattern = field(raw, "pattern");
  const categoryId = field(raw, "category_id");
  const exclude = field(raw, "action") === EXCLUDE;
  if (typeof id !== "string" || typeof pattern !== "string" || (!exclude && typeof categoryId !== "string")) return null;
  const hits = field(raw, "hits");
  return {
    id,
    pattern,
    categoryId: exclude ? null : (categoryId as string),
    exclude,
    learned: field(raw, "source") === "learned",
    hits: typeof hits === "number" ? hits : 0,
    archived: field(raw, "category_archived") === true,
  };
}

async function fetchRules(): Promise<Rule[] | null> {
  const { status, body } = await getJson("/api/rules");
  const items = field(body, "items");
  return status === 200 && Array.isArray(items) ? items.map(toRule).filter((r): r is Rule => r !== null) : null;
}

type Ask = { readonly ruleId: string; readonly candidates: number; readonly protectedManual: number };

/** Svaret på en sparad regel: frågan om tidigare transaktioner, null om det inte finns några, eller ett fel. */
function outcome({ status, body }: ApiResult): Ask | null | string {
  if (status === 400) return field(body, "error") === "unknown_category" ? "Välj en kategori som finns." : "Skriv början av ett namn, till exempel IKEA.";
  if (status !== 200 && status !== 201) return "Det gick inte att spara regeln. Försök igen.";
  const ruleId = field(field(body, "rule"), "id");
  const candidates = field(body, "retroactive_candidates");
  const manual = field(body, "protected_manual");
  if (typeof ruleId !== "string" || typeof candidates !== "number" || candidates === 0) return null;
  return { ruleId, candidates, protectedManual: typeof manual === "number" ? manual : 0 };
}

/** Mönster och kategori (eller Räkna inte), för en ny regel eller en som ändras. */
function RuleForm(props: { title: string; rule?: Rule; categories: Categories; onSaved: (ask: Ask | null) => void; onExcluded: (matches: number) => void; onClose: () => void }) {
  const [pattern, setPattern] = useState(props.rule?.pattern ?? "");
  const [categoryId, setCategoryId] = useState(props.rule?.exclude ? EXCLUDE : (props.rule?.categoryId ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Antalet träffar för en ny Räkna inte-regel, som visas innan den sparas. */
  const [confirm, setConfirm] = useState<number | null>(null);

  /** Sparar en Räkna inte-regel: ny med POST, ändrad med PATCH där bara namnet går att byta. */
  const saveExclude = async () => {
    setBusy(true);
    const result = props.rule ? await patchJson(`/api/rules/${encodeURIComponent(props.rule.id)}`, { pattern }) : await postJson("/api/rules", { pattern, action: EXCLUDE });
    setBusy(false);
    const matches = field(result.body, "matches");
    if ((result.status === 200 || result.status === 201) && typeof matches === "number") props.onExcluded(matches);
    else setError(result.status === 400 ? "Skriv början av ett namn, till exempel IKEA." : "Det gick inte att spara regeln. Försök igen.");
  };

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (categoryId === EXCLUDE && props.rule) return saveExclude();
    setBusy(true);
    if (categoryId === EXCLUDE) {
      const { status, body } = await postJson("/api/rules", { pattern, action: EXCLUDE, preview: true });
      setBusy(false);
      const matches = field(body, "matches");
      if (status === 200 && typeof matches === "number") setConfirm(matches);
      else setError(status === 400 ? "Skriv början av ett namn, till exempel IKEA." : "Det gick inte att räkna träffarna. Försök igen.");
      return;
    }
    const body = { pattern, category_id: categoryId };
    const result = props.rule ? await patchJson(`/api/rules/${encodeURIComponent(props.rule.id)}`, body) : await postJson("/api/rules", body);
    setBusy(false);
    const next = outcome(result);
    if (typeof next === "string") setError(next);
    else props.onSaved(next);
  };

  if (confirm !== null) {
    return (
      <div className="tx-editor">
        <p>Regeln träffar {confirm} transaktioner. De räknas inte i budget och översikt. Det du själv har valt ändras inte.</p>
        {error && <p role="alert">{error}</p>}
        <p>
          <button type="button" className="primary small" disabled={busy} onClick={() => void saveExclude()}>
            Spara regeln
          </button>
          <button type="button" className="small" onClick={props.onClose}>
            Avbryt
          </button>
        </p>
      </div>
    );
  }
  return (
    <form className="tx-editor" aria-label={props.title} onSubmit={(e) => void save(e)}>
      <label>
        Allt som börjar med
        <input value={pattern} maxLength={60} placeholder="IKEA" onChange={(e) => { setPattern(e.target.value); }} />
      </label>
      {!props.rule?.exclude && (
        <label>
          Får kategorin
          <select value={categoryId} onChange={(e) => { setCategoryId(e.target.value); }}>
            <option value="">Välj kategori</option>
            {!props.rule && <option value={EXCLUDE}>Räkna inte i budget och översikt</option>}
            {props.categories.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        <button type="submit" className="primary small" disabled={busy || categoryId === "" || pattern.trim() === ""}>
          Spara
        </button>
        <button type="button" className="small" onClick={props.onClose}>
          Avbryt
        </button>
      </p>
    </form>
  );
}

type Mode =
  | { readonly kind: "add" }
  | { readonly kind: "menu" | "matches" | "edit" | "delete"; readonly id: string }
  | { readonly kind: "ask"; readonly ask: Ask }
  | { readonly kind: "all"; readonly count: number };

export function RulesView() {
  const [rules, setRules] = useState<Rule[] | null | "error">(null);
  const [categories, setCategories] = useState<Categories>(NO_CATEGORIES);
  const [mode, setMode] = useState<Mode | null>(null);
  const [filter, setFilter] = useState("");
  const toast = useToast();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void fetchCategories().then(setCategories);
  }, []);
  useEffect(() => {
    let current = true;
    void fetchRules().then((loaded) => {
      if (current) setRules(loaded ?? "error");
    });
    return () => {
      current = false;
    };
  }, [reload]);

  /** Stänger det som är öppet, hämtar om reglerna och säger hur det gick. */
  const refresh = (ok: boolean, message: string) => {
    if (ok) toast.done(message);
    else toast.problem(message);
    setMode(null);
    setReload((n) => n + 1);
  };
  const saved = (ask: Ask | null) => {
    if (ask) setMode({ kind: "ask", ask });
    else refresh(true, "Regeln är sparad och gäller nya transaktioner.");
  };
  const excluded = (matches: number) => {
    refresh(true, `Regeln är sparad. ${String(matches)} transaktioner räknas inte längre.`);
  };
  const apply = async (ruleId: string) => {
    const { status, body } = await postJson(`/api/rules/${encodeURIComponent(ruleId)}/apply`, {});
    const updated = field(body, "updated");
    if (status === 200 && typeof updated === "number") refresh(true, `${String(updated)} transaktioner fick den nya kategorin.`);
    else refresh(false, "Det gick inte att applicera regeln. Försök igen.");
  };
  /** "Applicera alla regler": räkna först, fråga, applicera sedan (KK-18-C). */
  const previewAll = async () => {
    const { status, body } = await postJson("/api/rules/apply-all", { preview: true });
    const count = field(body, "would_update");
    if (status !== 200 || typeof count !== "number") toast.problem("Det gick inte att räkna. Försök igen.");
    else if (count === 0) refresh(true, "Alla transaktioner har redan kategorin som reglerna ger.");
    else setMode({ kind: "all", count });
  };
  const applyAllRules = async () => {
    const { status, body } = await postJson("/api/rules/apply-all", {});
    const updated = field(body, "updated");
    if (status === 200 && typeof updated === "number") refresh(true, `${String(updated)} transaktioner fick ny kategori.`);
    else refresh(false, "Det gick inte att applicera reglerna. Försök igen.");
  };
  const remove = async (ruleId: string) => {
    const { status } = await deleteJson(`/api/rules/${encodeURIComponent(ruleId)}`);
    if (status === 204) refresh(true, "Regeln är borttagen.");
    else refresh(false, "Det gick inte att ta bort regeln. Försök igen.");
  };

  const header = (
    <>
      <p>
        <Link to="/installningar">‹ Inställningar</Link>
      </p>
      <h1>Regler</h1>
    </>
  );
  if (rules === null) return <main>{header}<p>Hämtar…</p></main>;
  if (rules === "error") return <main>{header}<p role="alert">Det gick inte att hämta reglerna. Försök igen om en stund.</p></main>;

  const name = (r: Rule) => (r.categoryId === null ? "Räknas inte" : (categories.names.get(r.categoryId) ?? r.categoryId));
  const query = filter.trim().toLocaleUpperCase("sv-SE");
  const shown = rules.filter((r) => query === "" || r.pattern.includes(query) || name(r).toLocaleUpperCase("sv-SE").includes(query));

  return (
    <main>
      {header}
      <p>En regel ger en kategori åt allt som börjar med ett visst namn. Den används vid varje synk. Manuellt valda kategorier ändras aldrig. En regel kan också göra att det den träffar inte räknas i budget och översikt.</p>
      <div className="sync">
        <SyncButton onDone={() => { setReload((n) => n + 1); }} />
        <button type="button" onClick={() => void previewAll()}>
          Applicera alla regler
        </button>
      </div>
      {mode?.kind === "all" && (
        <section className="card">
          <p>
            {mode.count} transaktioner får ny kategori enligt reglerna. Manuellt valda ändras aldrig, och ingen kategori tas bort.
          </p>
          <p className="actions">
            <button type="button" className="primary" onClick={() => void applyAllRules()}>
              Applicera
            </button>
            <button type="button" onClick={() => { setMode(null); }}>
              Avbryt
            </button>
          </p>
        </section>
      )}
      {mode?.kind === "ask" && (
        <section className="card">
          <p>
            Regeln matchar {mode.ask.candidates} tidigare transaktioner.
            {mode.ask.protectedManual > 0 ? ` ${String(mode.ask.protectedManual)} manuellt valda ändras inte.` : ""}
          </p>
          <RuleMatches ruleId={mode.ask.ruleId} />
          <p className="actions">
            <button type="button" className="primary" onClick={() => void apply(mode.ask.ruleId)}>
              Applicera på dem
            </button>
            <button type="button" onClick={() => { refresh(true, "Regeln är sparad och gäller nya transaktioner."); }}>
              Inte nu
            </button>
          </p>
        </section>
      )}
      {mode?.kind === "add" ? (
        <section className="card">
          <RuleForm title="Ny regel" categories={categories} onSaved={saved} onExcluded={excluded} onClose={() => { setMode(null); }} />
        </section>
      ) : (
        <p>
          <button type="button" className="primary" onClick={() => { setMode({ kind: "add" }); }}>
            Ny regel
          </button>
        </p>
      )}
      <form role="search" onSubmit={(e) => { e.preventDefault(); }}>
        <input type="search" aria-label="Sök regel" placeholder="Sök namn eller kategori" value={filter} onChange={(e) => { setFilter(e.target.value); }} />
      </form>
      {shown.length === 0 ? (
        <p>Inga regler matchar.</p>
      ) : (
        <ul aria-label="Regler">
          {shown.map((r) => {
            const open = mode !== null && "id" in mode && mode.id === r.id ? mode.kind : null;
            return (
              <li key={r.id} className="tx">
                <div className="tx-main">
                  <span className="tx-name">{r.pattern}</span>
                  {open === null && (
                    <button type="button" className="small" aria-label={`Ändra regeln ${r.pattern}`} onClick={() => { setMode({ kind: "menu", id: r.id }); }}>
                      Ändra
                    </button>
                  )}
                </div>
                <small className="tx-notes">
                  → {name(r)} · {r.learned ? "Egen" : "Mall"} · {r.hits === 1 ? "1 träff" : `${String(r.hits)} träffar`}
                </small>
                {r.archived && <span className="badge warn">Kategorin är arkiverad</span>}
                {open === "menu" && (
                  <div className="tx-actions">
                    {!r.exclude && (
                      <button type="button" className="small" onClick={() => { setMode({ kind: "matches", id: r.id }); }}>
                        Visa träffar
                      </button>
                    )}
                    <button type="button" className="small" onClick={() => { setMode({ kind: "edit", id: r.id }); }}>
                      {r.exclude ? "Ändra namn" : "Ändra namn eller kategori"}
                    </button>
                    <button type="button" className="small" onClick={() => { setMode({ kind: "delete", id: r.id }); }}>
                      Ta bort
                    </button>
                    <button type="button" className="small" onClick={() => { setMode(null); }}>
                      Stäng
                    </button>
                  </div>
                )}
                {open === "matches" && (
                  <div className="tx-editor">
                    <RuleMatches ruleId={r.id} />
                    <p>
                      <button type="button" className="small" onClick={() => { setMode(null); }}>
                        Stäng
                      </button>
                    </p>
                  </div>
                )}
                {open === "edit" && <RuleForm title={`Ändra regeln ${r.pattern}`} rule={r} categories={categories} onSaved={saved} onExcluded={excluded} onClose={() => { setMode(null); }} />}
                {open === "delete" && (
                  <div className="tx-editor">
                    <p>{r.exclude ? "Ta bort regeln? Dess träffar räknas igen, utom det du själv har valt." : "Ta bort regeln? Transaktioner som redan har fått kategorin behåller den."}</p>
                    <p>
                      <button type="button" className="danger small" onClick={() => void remove(r.id)}>
                        Ta bort
                      </button>
                      <button type="button" className="small" onClick={() => { setMode(null); }}>
                        Avbryt
                      </button>
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
