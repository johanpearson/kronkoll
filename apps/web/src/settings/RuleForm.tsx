// Formuläret för en regel (#251, KK-18-B, KK-47, KK-58-B, KK-39-C): vad regeln träffar (börjar med eller innehåller),
// text och kategori, eller Räkna inte. Medan man skriver visas hur många transaktioner regeln träffar och några
// exempel, innan något sparas (KK-58-B). Finns manuellt valda bland träffarna kan man välja att skriva över dem,
// ett engångsval vid sparandet. En Räkna inte-regel gäller hela historiken direkt, så den visar först hur många
// den träffar och sparas när användaren bekräftar (KK-39-C). Bankens text visas som text (KK-30).
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useEffect, useId, useState, type SyntheticEvent } from "react";
import { field, patchJson, postJson, type ApiResult } from "../api.ts";
import type { Categories } from "../transactions/TransactionsView.tsx";
import { Button } from "../ui/Button.tsx";
import { List, ListRow } from "../ui/ListRow.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Switch } from "../ui/Switch.tsx";

/** Värdet i kategorivalet som betyder Räkna inte i stället för en kategori. */
export const EXCLUDE = "exclude";
/** Så länge efter senaste tecknet som förhandsvisningen väntar, så att den inte frågar för varje tangent. */
export const PREVIEW_DELAY_MS = 300;
/** Så många exempel som visas. Antalen räknas på alla träffar. */
const EXAMPLES = 3;

export interface FormRule {
  readonly id: string;
  readonly pattern: string;
  readonly categoryId: string | null;
  readonly exclude: boolean;
  readonly contains: boolean;
}

interface Hit {
  readonly id: string;
  readonly date: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly effect: string;
}

interface Preview {
  readonly total: number;
  readonly change: number;
  readonly unchanged: number;
  readonly manual: number;
  readonly items: readonly Hit[];
}

const EFFECT: Record<string, string> = {
  change: "Får kategorin",
  unchanged: "Har redan kategorin",
  manual: "Manuellt vald",
};

const count = (value: unknown) => (typeof value === "number" ? value : 0);

/** Träffarna i svaret på en förhandsvisning, eller null om svaret inte har dem. */
function toPreview(body: unknown): Preview | null {
  const matches = field(body, "matches");
  const items = field(matches, "items");
  if (!Array.isArray(items)) return null;
  return {
    total: count(field(matches, "total")),
    change: count(field(matches, "change")),
    unchanged: count(field(matches, "unchanged")),
    manual: count(field(matches, "manual")),
    items: items.flatMap((raw): Hit[] => {
      const id = field(raw, "id");
      const date = field(raw, "transaction_date");
      const amount = field(raw, "amount_minor");
      if (typeof id !== "string" || typeof date !== "string" || typeof amount !== "number") return [];
      const name = field(raw, "name");
      return [{ id, date, name: typeof name === "string" && name !== "" ? name : "Okänd motpart", amountMinor: amount, effect: String(field(raw, "effect")) }];
    }),
  };
}

/** Svaret på en sparad regel: hur många tidigare transaktioner som fick kategorin (KK-58-A), eller ett fel som text. */
function outcome({ status, body }: ApiResult): number | string {
  if (status === 400) return field(body, "error") === "unknown_category" ? "Välj en kategori som finns." : "Skriv en text, till exempel IKEA.";
  if (status !== 200 && status !== 201) return "Det gick inte att spara regeln. Försök igen.";
  const applied = field(body, "applied");
  return typeof applied === "number" ? applied : 0;
}

/** Sammanfattningen av träffarna i en mening: bara det som inte är noll. */
function summary(p: Preview): string {
  if (p.total === 0) return "Regeln träffar inga transaktioner än.";
  const parts = [
    p.change > 0 ? `${String(p.change)} får kategorin` : null,
    p.unchanged > 0 ? `${String(p.unchanged)} har redan kategorin` : null,
    p.manual > 0 ? `${String(p.manual)} är manuellt valda` : null,
  ].filter((part) => part !== null);
  return `Regeln träffar ${String(p.total)} transaktioner: ${parts.join(", ")}.`;
}

/** Mönster och kategori (eller Räkna inte), för en ny regel eller en som ändras. */
export function RuleForm(props: { title: string; rule?: FormRule; categories: Categories; onSaved: (applied: number) => void; onExcluded: (matches: number) => void; onClose: () => void }) {
  const [pattern, setPattern] = useState(props.rule?.pattern ?? "");
  const [match, setMatch] = useState<"prefix" | "contains">(props.rule?.contains ? "contains" : "prefix");
  const [categoryId, setCategoryId] = useState(props.rule?.exclude ? EXCLUDE : (props.rule?.categoryId ?? ""));
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Antalet träffar för en ny Räkna inte-regel, som visas innan den sparas. */
  const [confirm, setConfirm] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const textId = useId();
  const categoryFieldId = useId();

  const previewable = categoryId !== "" && categoryId !== EXCLUDE && pattern.trim() !== "";
  const manual = preview?.manual ?? 0;
  /** Valet gäller bara när det finns manuellt valda att skriva över. */
  const overwriting = override && manual > 0;

  // Förhandsvisar regeln som den skulle bli, en stund efter senaste ändringen, och struntar i svar som kommer för sent.
  const ruleId = props.rule?.id;
  useEffect(() => {
    if (!previewable) {
      setPreview(null);
      setPreviewFailed(false);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      const request = { pattern, match, category_id: categoryId, preview: true, override_manual: override };
      const send = ruleId === undefined ? postJson("/api/rules", request) : patchJson(`/api/rules/${encodeURIComponent(ruleId)}`, request);
      void send.then(({ status, body }) => {
        if (!current) return;
        const next = status === 200 ? toPreview(body) : null;
        setPreview(next);
        // Ett fel i texten eller kategorin (400) har sitt eget besked när man sparar.
        setPreviewFailed(next === null && status !== 400);
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [previewable, pattern, match, categoryId, override, ruleId]);

  /** Sparar en Räkna inte-regel: ny med POST, ändrad med PATCH där bara namnet går att byta. */
  const saveExclude = async () => {
    setBusy(true);
    const result = props.rule ? await patchJson(`/api/rules/${encodeURIComponent(props.rule.id)}`, { pattern, match }) : await postJson("/api/rules", { pattern, match, action: EXCLUDE });
    setBusy(false);
    const matches = field(result.body, "matches");
    if ((result.status === 200 || result.status === 201) && typeof matches === "number") props.onExcluded(matches);
    else setError(result.status === 400 ? "Skriv en text, till exempel IKEA." : "Det gick inte att spara regeln. Försök igen.");
  };

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (categoryId === EXCLUDE && props.rule) return saveExclude();
    setBusy(true);
    if (categoryId === EXCLUDE) {
      const { status, body } = await postJson("/api/rules", { pattern, match, action: EXCLUDE, preview: true });
      setBusy(false);
      const matches = field(body, "matches");
      if (status === 200 && typeof matches === "number") setConfirm(matches);
      else setError(status === 400 ? "Skriv en text, till exempel IKEA." : "Det gick inte att räkna träffarna. Försök igen.");
      return;
    }
    const body = { pattern, match, category_id: categoryId, ...(overwriting ? { override_manual: true } : {}) };
    const result = props.rule ? await patchJson(`/api/rules/${encodeURIComponent(props.rule.id)}`, body) : await postJson("/api/rules", body);
    setBusy(false);
    const next = outcome(result);
    if (typeof next === "string") setError(next);
    else props.onSaved(next);
  };

  if (confirm !== null) {
    return (
      <div className="ui-stack">
        <p className="ui-body">Regeln träffar {confirm} transaktioner. De räknas inte i budget och översikt. Det du själv har valt ändras inte.</p>
        {error && (
          <p role="alert" className="ui-field-error">
            {error}
          </p>
        )}
        <Button variant="primary" block busy={busy} onClick={() => void saveExclude()}>
          Spara regeln
        </Button>
        <Button variant="quiet" block onClick={props.onClose}>
          Avbryt
        </Button>
      </div>
    );
  }
  return (
    <form className="ui-stack" aria-label={props.title} onSubmit={(e) => void save(e)}>
      <SegmentedControl
        label="Träffar"
        options={[
          { value: "prefix", label: "Börjar med" },
          { value: "contains", label: "Innehåller" },
        ]}
        value={match}
        onChange={setMatch}
      />
      <div className="ui-field">
        <label htmlFor={textId} className="ui-label">
          Text
        </label>
        <input
          id={textId}
          data-autofocus
          className="ui-input"
          value={pattern}
          maxLength={60}
          placeholder={match === "contains" ? "amazon" : "IKEA"}
          aria-describedby={`${textId}-hint`}
          onChange={(e) => { setPattern(e.target.value); }}
        />
        <p id={`${textId}-hint`} className="ui-caption">
          Versaler och gemener spelar ingen roll.
        </p>
      </div>
      {!props.rule?.exclude && (
        <div className="ui-field">
          <label htmlFor={categoryFieldId} className="ui-label">
            Får kategorin
          </label>
          <select id={categoryFieldId} className="ui-input" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); }}>
            <option value="">Välj kategori</option>
            {!props.rule && <option value={EXCLUDE}>Räkna inte i budget och översikt</option>}
            {props.categories.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div aria-live="polite" className="ui-stack">
        {preview && (
          <>
            <p className="ui-body">{summary(preview)}</p>
            {preview.items.length > 0 && (
              <List label="Exempel på träffar">
                {preview.items.slice(0, EXAMPLES).map((hit) => (
                  <ListRow key={hit.id} label={hit.name} detail={`${formatDateShort(hit.date)} · ${EFFECT[hit.effect] ?? hit.effect}`} value={formatSek(hit.amountMinor)} />
                ))}
              </List>
            )}
          </>
        )}
        {previewFailed && <p className="ui-caption">Det gick inte att räkna träffarna. Du kan ändå spara regeln.</p>}
      </div>
      {manual > 0 && (
        <div className="ui-stack">
          <Switch checked={override} onChange={setOverride}>
            Skriv över även manuellt kategoriserade
          </Switch>
          <p className="ui-caption">
            {override ? `${String(manual)} manuellt valda får kategorin.` : `${String(manual)} manuellt valda ändras inte. Det du själv har valt rörs annars aldrig.`}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" block busy={busy} disabled={categoryId === "" || pattern.trim() === ""}>
        Spara
      </Button>
      <Button variant="quiet" block onClick={props.onClose}>
        Avbryt
      </Button>
    </form>
  );
}
