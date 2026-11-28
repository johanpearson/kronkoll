// Regler (#251, KK-18-B, KK-18-C, KK-58): alla kategoriseringsregler som listrader i den ordning som gäller. Villkoret
// står i klartext ("Innehåller AMAZON → Hushåll › Förbrukning") med källa och antal träffar under. De egna reglerna
// kommer först i sin ordning, den som står först vinner (KK-58-C), sedan mallreglerna och Räkna inte-reglerna.
// Ett tryck på en rad öppnar ett ark med Visa träffar, Ändra, Flytta upp och ner och Ta bort. En ny eller ändrad
// regel tillämpas direkt av API:t, även på tidigare transaktioner (KK-58-A), och vyn säger hur många. Manuellt valda
// ändras aldrig. En regel vars kategori är arkiverad markeras med text. "Applicera alla regler" kör alla regler över
// historiken efter en fråga. En regel kan också ha åtgärden Räkna inte (KK-39-C): den gäller hela historiken direkt,
// så formuläret visar först hur många den träffar och sparar när användaren bekräftar. Egna val ändras aldrig.
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteJson, field, getJson, postJson, putJson } from "../api.ts";
import { SyncStatus } from "../sync/SyncStatus.tsx";
import { useToast } from "../toast.tsx";
import { fetchCategories, NO_CATEGORIES, type Categories } from "../transactions/TransactionsView.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { List, ListRow } from "../ui/ListRow.tsx";
import { Dialog, Sheet } from "../ui/Modal.tsx";
import { EmptyState, Skeleton } from "../ui/Surface.tsx";
import { ResetRules } from "./ResetRules.tsx";
import { EXCLUDE, RuleForm } from "./RuleForm.tsx";
import { RuleMatches } from "./RuleMatches.tsx";

interface Rule {
  readonly id: string;
  readonly pattern: string;
  /** Null för en Räkna inte-regel. */
  readonly categoryId: string | null;
  readonly exclude: boolean;
  /** Börjar med en motpart, eller innehåller en text var som helst (KK-47). */
  readonly contains: boolean;
  readonly learned: boolean;
  readonly hits: number;
  readonly archived: boolean;
  /** Platsen i användarens ordning, lägst först. Bara egna kategoriregler har en (KK-58-C). */
  readonly position: number | null;
}

function toRule(raw: unknown): Rule | null {
  const id = field(raw, "id");
  const pattern = field(raw, "pattern");
  const categoryId = field(raw, "category_id");
  const exclude = field(raw, "action") === EXCLUDE;
  if (typeof id !== "string" || typeof pattern !== "string" || (!exclude && typeof categoryId !== "string")) return null;
  const hits = field(raw, "hits");
  const position = field(raw, "position");
  return {
    id,
    pattern,
    categoryId: exclude ? null : (categoryId as string),
    exclude,
    contains: field(raw, "match") === "description_contains",
    learned: field(raw, "source") === "learned",
    hits: typeof hits === "number" ? hits : 0,
    archived: field(raw, "category_archived") === true,
    position: typeof position === "number" ? position : null,
  };
}

async function fetchRules(): Promise<Rule[] | null> {
  const { status, body } = await getJson("/api/rules");
  const items = field(body, "items");
  return status === 200 && Array.isArray(items) ? items.map(toRule).filter((r): r is Rule => r !== null) : null;
}

type Open = { readonly id: string; readonly view: "menu" | "matches" | "edit" } | { readonly id: null; readonly view: "add" };

/** Egna kategoriregler med en plats ligger först i sin ordning, och resten efter dem i den ordning API:t gav. */
const isOwn = (r: Rule) => r.learned && !r.exclude && r.position !== null;
function inOrder(rules: readonly Rule[]): Rule[] {
  const own = rules.filter(isOwn).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return [...own, ...rules.filter((r) => !isOwn(r))];
}

/** Åtgärderna för en regel i ett ark. Flytta upp och ner lämnar arket öppet, så att man kan flytta flera steg. */
function RuleMenu(props: { rule: Rule; own: readonly Rule[]; onView: (view: "matches" | "edit") => void; onMoved: () => void; onDelete: () => void }) {
  const r = props.rule;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = props.own.findIndex((o) => o.id === r.id);
  const move = async (to: number) => {
    const order = props.own.map((o) => o.id);
    order.splice(at, 1);
    order.splice(to, 0, r.id);
    setBusy(true);
    setError(null);
    const { status } = await putJson("/api/rules/order", { order });
    setBusy(false);
    if (status === 200) props.onMoved();
    else setError("Det gick inte att flytta regeln. Försök igen.");
  };
  return (
    <div className="ui-stack">
      {at >= 0 && props.own.length > 1 && (
        <p className="ui-caption" role="status">
          Plats {at + 1} av {props.own.length}. Regeln som står först vinner när flera träffar.
        </p>
      )}
      {error && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      <List label={`Åtgärder för regeln ${r.pattern}`}>
        {!r.exclude && <ListRow label="Visa träffar" onClick={() => { props.onView("matches"); }} />}
        {at > 0 && !busy && <ListRow label="Flytta upp" onClick={() => void move(at - 1)} />}
        {at >= 0 && at < props.own.length - 1 && !busy && <ListRow label="Flytta ner" onClick={() => void move(at + 1)} />}
        <ListRow label={r.exclude ? "Ändra namn" : "Ändra namn eller kategori"} onClick={() => { props.onView("edit"); }} />
        <ListRow label="Ta bort" danger onClick={props.onDelete} />
      </List>
    </div>
  );
}

export function RulesView() {
  const [rules, setRules] = useState<Rule[] | null | "error">(null);
  const [categories, setCategories] = useState<Categories>(NO_CATEGORIES);
  const [open, setOpen] = useState<Open | null>(null);
  /** Regeln som frågan om att ta bort gäller. */
  const [removing, setRemoving] = useState<string | null>(null);
  /** Hur många transaktioner "Applicera alla regler" skulle ändra, när frågan visas. */
  const [all, setAll] = useState<number | null>(null);
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
    setOpen(null);
    setRemoving(null);
    setAll(null);
    setReload((n) => n + 1);
  };
  const saved = (applied: number) => {
    if (applied > 0) refresh(true, `Regeln är sparad. ${String(applied)} tidigare transaktioner fick kategorin.`);
    else refresh(true, "Regeln är sparad och gäller nya transaktioner.");
  };
  const excluded = (matches: number) => {
    refresh(true, `Regeln är sparad. ${String(matches)} transaktioner räknas inte längre.`);
  };
  /** "Applicera alla regler": räkna först, fråga, applicera sedan (KK-18-C). */
  const previewAll = async () => {
    const { status, body } = await postJson("/api/rules/apply-all", { preview: true });
    const count = field(body, "would_update");
    if (status !== 200 || typeof count !== "number") toast.problem("Det gick inte att räkna. Försök igen.");
    else if (count === 0) refresh(true, "Alla transaktioner har redan kategorin som reglerna ger.");
    else setAll(count);
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

  if (rules === null) return <main><h1>Regler</h1><Skeleton lines={6} /></main>;
  if (rules === "error") return <main><h1>Regler</h1><p role="alert">Det gick inte att hämta reglerna. Försök igen om en stund.</p></main>;

  const ordered = inOrder(rules);
  const own = ordered.filter(isOwn);
  const name = (r: Rule) => (r.categoryId === null ? "Räknas inte" : (categories.names.get(r.categoryId) ?? r.categoryId));
  const query = filter.trim().toLocaleUpperCase("sv-SE");
  const shown = ordered.filter((r) => query === "" || r.pattern.includes(query) || name(r).toLocaleUpperCase("sv-SE").includes(query));
  const selected = open?.id === null || open === null ? undefined : rules.find((r) => r.id === open.id);
  const removed = removing === null ? undefined : rules.find((r) => r.id === removing);
  const close = () => { setOpen(null); };

  return (
    <main>
      <div className="page-header">
        <h1>Regler</h1>
        <SyncStatus onDone={() => { setReload((n) => n + 1); }} />
      </div>
      <p className="ui-body">En regel ger en kategori åt allt som börjar med eller innehåller en viss text, oavsett versaler. Den används vid varje synk. Manuellt valda kategorier ändras aldrig. En regel kan också göra att det den träffar inte räknas i budget och översikt.</p>
      <Button variant="primary" block icon={Plus} onClick={() => { setOpen({ id: null, view: "add" }); }}>
        Ny regel
      </Button>
      <Button block onClick={() => void previewAll()}>
        Applicera alla regler
      </Button>
      <form role="search" onSubmit={(e) => { e.preventDefault(); }}>
        <input className="ui-input" type="search" aria-label="Sök regel" placeholder="Sök namn eller kategori" value={filter} onChange={(e) => { setFilter(e.target.value); }} />
      </form>
      {shown.length === 0 ? (
        <EmptyState title="Inga regler">{rules.length === 0 ? "Det finns inga regler än." : "Inga regler matchar."}</EmptyState>
      ) : (
        <List label="Regler">
          {shown.map((r) => (
            <ListRow
              key={r.id}
              label={`${r.contains ? "Innehåller" : "Börjar med"} ${r.pattern} → ${name(r)}`}
              detail={
                <>
                  {r.learned ? "Egen" : "Mall"} · {r.hits === 1 ? "1 träff" : `${String(r.hits)} träffar`}
                  {r.archived && (
                    <>
                      {" "}
                      <Chip tone="warning">Kategorin är arkiverad</Chip>
                    </>
                  )}
                </>
              }
              onClick={() => { setOpen({ id: r.id, view: "menu" }); }}
            />
          ))}
        </List>
      )}
      <ResetRules onDone={() => { setOpen(null); setReload((n) => n + 1); }} />
      <List label="Börja om med kategorierna">
        <ListRow label="Rensa alla kategorier" to="/installningar/kategorier" />
      </List>
      <Sheet open={open?.view === "add"} title="Ny regel" onClose={close}>
        <RuleForm title="Ny regel" categories={categories} onSaved={saved} onExcluded={excluded} onClose={close} />
      </Sheet>
      <Sheet open={selected !== undefined} title={selected === undefined ? "" : `Regeln ${selected.pattern}`} onClose={close}>
        {selected && open?.view === "menu" && (
          <RuleMenu rule={selected} own={own} onView={(view) => { setOpen({ id: selected.id, view }); }} onMoved={() => { setReload((n) => n + 1); }} onDelete={() => { setRemoving(selected.id); setOpen(null); }} />
        )}
        {selected && open?.view === "matches" && <RuleMatches ruleId={selected.id} />}
        {selected && open?.view === "edit" && <RuleForm title={`Ändra regeln ${selected.pattern}`} rule={selected} categories={categories} onSaved={saved} onExcluded={excluded} onClose={close} />}
      </Sheet>
      <Dialog
        open={removed !== undefined}
        title={removed === undefined ? "" : `Ta bort regeln ${removed.pattern}?`}
        onClose={() => { setRemoving(null); }}
        actions={
          <>
            <Button variant="danger" block onClick={() => { if (removed) void remove(removed.id); }}>
              Ta bort
            </Button>
            <Button variant="quiet" block onClick={() => { setRemoving(null); }}>
              Avbryt
            </Button>
          </>
        }
      >
        <p>{removed?.exclude ? "Dess träffar räknas igen, utom det du själv har valt." : "Transaktioner som redan har fått kategorin behåller den."}</p>
      </Dialog>
      <Dialog
        open={all !== null}
        title="Applicera alla regler?"
        onClose={() => { setAll(null); }}
        actions={
          <>
            <Button variant="primary" block onClick={() => void applyAllRules()}>
              Applicera
            </Button>
            <Button variant="quiet" block onClick={() => { setAll(null); }}>
              Avbryt
            </Button>
          </>
        }
      >
        <p>{all} transaktioner får ny kategori enligt reglerna. Manuellt valda ändras aldrig, och ingen kategori tas bort.</p>
      </Dialog>
    </main>
  );
}
