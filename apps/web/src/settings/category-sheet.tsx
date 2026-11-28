// Ändra en kategori i ett ark (#251, KK-18-A): först ett val av åtgärd, sedan ett litet formulär. Reglerna
// (två nivåer, unika namn, samma nivå och typ vid sammanslagning) finns i domänen på servern, och dess
// förklaring visas vid fältet. Efter en lyckad ändring hämtar vyn listan igen.
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { field, getJson, patchJson, postJson, type ApiResult } from "../api.ts";
import { Button } from "../ui/Button.tsx";
import { List, ListRow } from "../ui/ListRow.tsx";
import { Sheet } from "../ui/Modal.tsx";

export interface Category {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly kind: string;
}

export async function fetchCategories(): Promise<Category[] | null> {
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

/** Hämtar kategorierna och hämtar om dem när reload ändras. */
export function useCategories(reload: number): Category[] | null | "error" {
  const [categories, setCategories] = useState<Category[] | null | "error">(null);
  useEffect(() => {
    let current = true;
    void fetchCategories().then((loaded) => {
      if (current) setCategories(loaded ?? "error");
    });
    return () => {
      current = false;
    };
  }, [reload]);
  return categories;
}

export const byName = (a: Category, b: Category) => a.name.localeCompare(b.name, "sv");

/** Felet att visa för ett svar som inte lyckades: domänens förklaring, eller ett allmänt fel. */
function failure({ status, body }: ApiResult): string | null {
  if (status >= 200 && status < 300) return null;
  const message = field(body, "message");
  return typeof message === "string" ? message : "Det gick inte att spara. Försök igen.";
}

type Mode = "menu" | "rename" | "add" | "merge" | "archive";

/** Vad arket gäller: en befintlig kategori, eller en ny huvudkategori. */
export type Target = { readonly category: Category; readonly mode: Mode } | { readonly category: null; readonly mode: "add" };

/** Ett fält eller ett val, en knapp och Avbryt. Felet visas vid fältet (KK-64-D). */
function Form(props: { label: string; submit: string; initial?: string; options?: readonly Category[]; danger?: boolean; text?: string; onSubmit: (value: string) => Promise<string | null>; onClose: () => void }) {
  const [value, setValue] = useState(props.initial ?? props.options?.[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  // Arket är redan öppet när man väljer en åtgärd, så fältet får fokus här och inte av arket.
  useEffect(() => {
    input.current?.focus();
  }, []);
  const send = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const problem = await props.onSubmit(value);
    setBusy(false);
    if (problem === null) props.onClose();
    else setError(problem);
  };
  const empty = props.options?.length === 0;
  return (
    <form className="ui-stack" onSubmit={(e) => void send(e)}>
      {props.text !== undefined && <p className="ui-body">{props.text}</p>}
      {empty && <p className="ui-body">Det finns ingen annan kategori på samma nivå att slå ihop med.</p>}
      {props.text === undefined && !empty && (
        <div className="ui-field">
          <label htmlFor={id} className="ui-label">
            {props.label}
          </label>
          {props.options ? (
            <select id={id} className="ui-input" value={value} onChange={(e) => { setValue(e.target.value); }}>
              {props.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <input id={id} ref={input} data-autofocus className="ui-input" value={value} maxLength={40} onChange={(e) => { setValue(e.target.value); }} />
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      <Button type="submit" variant={props.danger ? "danger" : "primary"} block busy={busy} disabled={empty}>
        {props.submit}
      </Button>
      <Button variant="quiet" block onClick={props.onClose}>
        Avbryt
      </Button>
    </form>
  );
}

const TITLE: Record<Mode, string> = { menu: "Ändra", rename: "Byt namn", add: "Ny underkategori", merge: "Slå ihop", archive: "Arkivera" };

export function CategorySheet(props: { target: Target | null; categories: readonly Category[]; onTarget: (target: Target | null) => void; onChanged: (mode: Mode) => void }) {
  const { target } = props;
  const close = () => { props.onTarget(null); };
  const done = (mode: Mode) => async (result: Promise<ApiResult>) => {
    const problem = failure(await result);
    if (problem === null) props.onChanged(mode);
    return problem;
  };

  let title = "";
  let body = null;
  if (target?.category === null) {
    title = "Ny huvudkategori";
    body = <Form label="Namn på huvudkategorin" submit="Lägg till" initial="" onSubmit={(name) => done("add")(postJson("/api/categories", { parent_id: null, name }))} onClose={close} />;
  } else if (target) {
    const c = target.category;
    const path = `/api/categories/${encodeURIComponent(c.id)}`;
    const main = c.parentId === null;
    const go = (mode: Mode) => () => { props.onTarget({ category: c, mode }); };
    title = target.mode === "menu" ? c.name : `${TITLE[target.mode]}: ${c.name}`;
    if (target.mode === "menu") {
      body = (
        <List label={`Åtgärder för ${c.name}`}>
          <ListRow label="Byt namn" onClick={go("rename")} />
          {main && <ListRow label="Ny underkategori" onClick={go("add")} />}
          <ListRow label="Slå ihop med en annan" onClick={go("merge")} />
          <ListRow label="Arkivera" danger onClick={go("archive")} />
        </List>
      );
    } else if (target.mode === "rename") {
      body = <Form label="Nytt namn" submit="Spara" initial={c.name} onSubmit={(name) => done("rename")(patchJson(path, { name }))} onClose={close} />;
    } else if (target.mode === "add") {
      body = <Form label="Namn på underkategorin" submit="Lägg till" initial="" onSubmit={(name) => done("add")(postJson("/api/categories", { parent_id: c.id, name }))} onClose={close} />;
    } else if (target.mode === "merge") {
      const peers = props.categories.filter((o) => o.id !== c.id && o.kind === c.kind && (o.parentId === null) === main).sort(byName);
      body = <Form label={`Slå ihop ${c.name} med`} submit="Slå ihop" options={peers} onSubmit={(into) => done("merge")(postJson(`${path}/merge`, { into_id: into }))} onClose={close} />;
    } else {
      const text = `${c.name}${main ? " och dess underkategorier" : ""} går inte att välja längre. Äldre transaktioner behåller kategorin.`;
      body = <Form label={`Arkivera ${c.name}`} submit="Arkivera" danger text={text} onSubmit={() => done("archive")(patchJson(path, { archived: true }))} onClose={close} />;
    }
  }
  return (
    <Sheet open={target !== null} title={title} onClose={close}>
      {body}
    </Sheet>
  );
}
