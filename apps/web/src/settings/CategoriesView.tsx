// Kategorier (#34, KK-18-A): huvudkategorier med sina underkategorier, per typ. Byt namn, lägg till,
// arkivera och slå ihop. Reglerna (två nivåer, unika namn, samma nivå och typ vid sammanslagning) finns
// i domänen på servern, och dess förklaring visas som den är. Arkiverade visas inte.
import { Pencil, X } from "lucide-react";
import { useEffect, useState, type SyntheticEvent } from "react";
import { field, getJson, patchJson, postJson, type ApiResult } from "../api.ts";
import { IconButton } from "../icon-button.tsx";
import { Link } from "../router.tsx";

interface Category {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly kind: string;
}

const KINDS = [
  { kind: "expense", title: "Utgifter" },
  { kind: "income", title: "Inkomster" },
  { kind: "transfer", title: "Överföringar" },
];

async function fetchCategories(): Promise<Category[] | null> {
  const { status, body } = await getJson("/api/categories");
  const items = field(body, "items");
  if (status !== 200 || !Array.isArray(items)) return null;
  return items.flatMap((raw) => {
    const id = field(raw, "id");
    const name = field(raw, "name");
    const parent = field(raw, "parent_id");
    const kind = field(raw, "kind");
    if (typeof id !== "string" || typeof name !== "string" || field(raw, "archived") === true) return [];
    return [{ id, name, parentId: typeof parent === "string" ? parent : null, kind: typeof kind === "string" ? kind : "expense" }];
  });
}

/** Felet att visa för ett svar som inte lyckades: domänens förklaring, eller ett allmänt fel. */
function failure({ status, body }: ApiResult): string | null {
  if (status >= 200 && status < 300) return null;
  const message = field(body, "message");
  return typeof message === "string" ? message : "Det gick inte att spara. Försök igen.";
}

type Edit = { readonly id: string; readonly mode: "menu" | "rename" | "add" | "merge" | "archive" } | { readonly id: null; readonly mode: "add" };

/** Ett litet formulär i raden: ett fält eller ett val, en knapp och Avbryt. */
function InlineForm(props: {
  label: string;
  submit: string;
  initial?: string;
  options?: readonly Category[];
  danger?: boolean;
  onSubmit: (value: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(props.initial ?? props.options?.[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const problem = await props.onSubmit(value);
    setBusy(false);
    if (problem === null) props.onClose();
    else setError(problem);
  };
  return (
    <form className="tx-editor" aria-label="Ändra kategori" onSubmit={(e) => void send(e)}>
      {props.options ? (
        props.options.length === 0 ? (
          <p>Det finns ingen annan kategori på samma nivå att slå ihop med.</p>
        ) : (
          <label>
            {props.label}
            <select value={value} onChange={(e) => { setValue(e.target.value); }}>
              {props.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )
      ) : props.initial === undefined && props.danger ? (
        <p>{props.label}</p>
      ) : (
        <label>
          {props.label}
          <input value={value} maxLength={40} onChange={(e) => { setValue(e.target.value); }} />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        <button type="submit" className={props.danger ? "danger small" : "primary small"} disabled={busy || props.options?.length === 0}>
          {props.submit}
        </button>
        <button type="button" className="small" onClick={props.onClose}>
          Avbryt
        </button>
      </p>
    </form>
  );
}

export function CategoriesView() {
  const [categories, setCategories] = useState<Category[] | null | "error">(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    void fetchCategories().then((loaded) => {
      if (current) setCategories(loaded ?? "error");
    });
    return () => {
      current = false;
    };
  }, [reload]);

  // Efter en lyckad ändring hämtas listan om, eftersom en ändring kan påverka flera kategorier.
  const done = async (result: Promise<ApiResult>) => {
    const problem = failure(await result);
    if (problem === null) setReload((n) => n + 1);
    return problem;
  };
  const close = () => { setEdit(null); };

  if (categories === null) return <main><h1>Kategorier</h1><p>Hämtar…</p></main>;
  if (categories === "error") return <main><h1>Kategorier</h1><p role="alert">Det gick inte att hämta kategorierna. Försök igen om en stund.</p></main>;

  const children = (id: string) => categories.filter((c) => c.parentId === id).sort((a, b) => a.name.localeCompare(b.name, "sv"));
  const peers = (c: Category) => categories.filter((o) => o.id !== c.id && o.kind === c.kind && (o.parentId === null) === (c.parentId === null));

  const row = (c: Category) => {
    const editing = edit?.id === c.id ? edit.mode : null;
    const path = `/api/categories/${encodeURIComponent(c.id)}`;
    return (
      <li key={c.id} className={c.parentId === null ? "tx" : "tx sub"}>
        <div className="tx-main">
          <span className="tx-name">{c.name}</span>
          {editing === null && <IconButton label={`Ändra ${c.name}`} icon={Pencil} onClick={() => { setEdit({ id: c.id, mode: "menu" }); }} />}
        </div>
        {/* Åtgärderna visas först när raden öppnas, så att listan är lätt att läsa. */}
        {editing === "menu" && (
          <div className="tx-actions">
            <button type="button" className="small" aria-label={`Byt namn på ${c.name}`} onClick={() => { setEdit({ id: c.id, mode: "rename" }); }}>
              Byt namn
            </button>
            {c.parentId === null && (
              <button type="button" className="small" aria-label={`Ny underkategori till ${c.name}`} onClick={() => { setEdit({ id: c.id, mode: "add" }); }}>
                Ny underkategori
              </button>
            )}
            <button type="button" className="small" aria-label={`Slå ihop ${c.name}`} onClick={() => { setEdit({ id: c.id, mode: "merge" }); }}>
              Slå ihop
            </button>
            <button type="button" className="small" aria-label={`Arkivera ${c.name}`} onClick={() => { setEdit({ id: c.id, mode: "archive" }); }}>
              Arkivera
            </button>
            <IconButton label="Stäng" icon={X} onClick={close} />
          </div>
        )}
        {editing === "rename" && <InlineForm label="Nytt namn" submit="Spara" initial={c.name} onSubmit={(name) => done(patchJson(path, { name }))} onClose={close} />}
        {editing === "add" && (
          <InlineForm label="Namn på underkategorin" submit="Lägg till" initial="" onSubmit={(name) => done(postJson("/api/categories", { parent_id: c.id, name }))} onClose={close} />
        )}
        {editing === "merge" && (
          <InlineForm
            label={`Slå ihop ${c.name} med`}
            submit="Slå ihop"
            options={peers(c)}
            onSubmit={(intoId) => done(postJson(`${path}/merge`, { into_id: intoId }))}
            onClose={close}
          />
        )}
        {editing === "archive" && (
          <InlineForm
            label={`Arkivera ${c.name}${c.parentId === null ? " och dess underkategorier" : ""}? Äldre transaktioner behåller kategorin, men den går inte att välja längre.`}
            submit="Arkivera"
            danger
            onSubmit={() => done(patchJson(path, { archived: true }))}
            onClose={close}
          />
        )}
      </li>
    );
  };

  return (
    <main>
      <p>
        <Link to="/installningar">‹ Inställningar</Link>
      </p>
      <h1>Kategorier</h1>
      {KINDS.map(({ kind, title }) => {
        const mains = categories.filter((c) => c.kind === kind && c.parentId === null).sort((a, b) => a.name.localeCompare(b.name, "sv"));
        if (mains.length === 0) return null;
        return (
          <section key={kind}>
            <h2>{title}</h2>
            <ul aria-label={title}>{mains.flatMap((m) => [row(m), ...children(m.id).map(row)])}</ul>
          </section>
        );
      })}
      {edit?.id === null ? (
        <section className="card">
          <InlineForm label="Namn på huvudkategorin" submit="Lägg till" initial="" onSubmit={(name) => done(postJson("/api/categories", { parent_id: null, name }))} onClose={close} />
        </section>
      ) : (
        <p>
          <button type="button" className="primary" onClick={() => { setEdit({ id: null, mode: "add" }); }}>
            Ny huvudkategori
          </button>
        </p>
      )}
    </main>
  );
}
