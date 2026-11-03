// Sätt budget för en period (#33, KK-20-A): ett belopp i kronor per huvudkategori, som standard. Under
// varje huvudkategori går det att fördela på underkategorier om man vill; huvudkategorins belopp är då
// taket. Fälten kan fyllas med föregående periods budget eller med snittet av utgifterna per
// huvudkategori de tre senaste perioderna. Förslaget sparas inte förrän användaren trycker Spara.
import { formatSek, parseAmount, suggestFromAverage, suggestFromPrevious, type BudgetLineInput } from "@kronkoll/domain";
import { useState, type SyntheticEvent } from "react";
import { putJson } from "../api.ts";
import { shiftPeriodKey, type Categories } from "../transactions/TransactionsView.tsx";

type Source = "manual" | "copy_previous" | "average_3m";

/** Det editorn behöver från en annan period. */
export interface PeriodData {
  readonly lines: readonly { readonly categoryId: string; readonly budgetMinor: number }[];
  /** Utfallet per huvudkategori, med underkategorierna summerade uppåt. */
  readonly groups: readonly { readonly categoryId: string; readonly actualMinor: number }[];
}

/** Öre som text för ett fält: hela kronor utan decimaler, annars med ören, t.ex. "6300" eller "6300,50". */
const toText = (ore: number) => (ore % 100 === 0 ? String(ore / 100) : (ore / 100).toFixed(2).replace(".", ","));

/** Fältets belopp i öre: null för tomt eller noll (ingen budget), undefined om texten inte är ett belopp. */
function parseField(text: string): number | null | undefined {
  // \s tar även hårda mellanslag, som Intl använder mellan tusental.
  const normalized = text.replace(/\s/gu, "").replace(",", ".");
  if (normalized === "") return null;
  try {
    const ore = parseAmount(normalized);
    if (ore < 0) return undefined;
    return ore === 0 ? null : ore;
  } catch {
    return undefined;
  }
}

const MONTH = new Intl.DateTimeFormat("sv-SE", { month: "long", timeZone: "UTC" });
const monthName = (key: string) => MONTH.format(new Date(`${key}-01T00:00:00Z`));

export function BudgetEditor(props: {
  periodKey: string;
  lines: readonly { readonly categoryId: string; readonly budgetMinor: number }[];
  categories: Categories;
  load: (key: string) => Promise<PeriodData | null>;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { budgetable, parentOf } = props.categories;
  const mains = budgetable.filter((c) => (parentOf.get(c.id) ?? null) === null);
  const subsOf = (mainId: string) => budgetable.filter((c) => parentOf.get(c.id) === mainId);
  const [amounts, setAmounts] = useState<ReadonlyMap<string, string>>(() => new Map(props.lines.map((l) => [l.categoryId, toText(l.budgetMinor)])));
  // Huvudkategorier som har budget på underkategorier visas utfällda från början.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(props.lines.flatMap((l) => parentOf.get(l.categoryId) ?? [])));
  const [source, setSource] = useState<Source>("manual");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const previousKey = shiftPeriodKey(props.periodKey, -1);
  const allowed = new Set(budgetable.map((c) => c.id));

  const fill = (lines: readonly BudgetLineInput[], from: Source, empty: string) => {
    const usable = lines.filter((l) => allowed.has(l.categoryId));
    if (usable.length === 0) {
      setMessage(empty);
      return;
    }
    setAmounts(new Map(usable.map((l) => [l.categoryId, toText(l.amountMinor)])));
    setOpen(new Set(usable.flatMap((l) => parentOf.get(l.categoryId) ?? [])));
    setSource(from);
    setMessage(null);
  };
  const setAmount = (id: string, text: string) => {
    setAmounts(new Map(amounts).set(id, text));
    setSource("manual");
  };
  /** Varning när underkategorierna tillsammans är mer än huvudkategorins belopp, som då gäller. */
  const overflow = (mainId: string): string | null => {
    const main = parseField(amounts.get(mainId) ?? "");
    const subs = subsOf(mainId).map((c) => parseField(amounts.get(c.id) ?? "") ?? 0);
    const sum = subs.reduce((a, b) => a + b, 0);
    return typeof main === "number" && sum > main
      ? `Underkategorierna är tillsammans ${formatSek(sum)}, mer än ${formatSek(main)}. Huvudkategorins belopp gäller.`
      : null;
  };

  const copyPrevious = async () => {
    setBusy(true);
    const previous = await props.load(previousKey);
    setBusy(false);
    if (!previous) {
      setMessage("Det gick inte att hämta förra periodens budget.");
      return;
    }
    fill(suggestFromPrevious(previous.lines.map((l) => ({ categoryId: l.categoryId, amountMinor: l.budgetMinor }))), "copy_previous", "Förra perioden har ingen budget att kopiera.");
  };

  const average = async () => {
    setBusy(true);
    const history = await Promise.all([1, 2, 3].map((n) => props.load(shiftPeriodKey(props.periodKey, -n))));
    setBusy(false);
    if (history.some((h) => h === null)) {
      setMessage("Det gick inte att hämta de tidigare perioderna.");
      return;
    }
    // Snittet räknas per huvudkategori, eftersom budgeten normalt sätts där.
    const perMain = history.map((h) => new Map((h?.groups ?? []).map((g) => [g.categoryId, g.actualMinor])));
    fill(suggestFromAverage(perMain), "average_3m", "Det finns inga utgifter de tre senaste perioderna att räkna snitt på.");
  };

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const lines: BudgetLineInput[] = [];
    for (const [categoryId, text] of amounts) {
      const amountMinor = parseField(text);
      if (amountMinor === undefined) {
        setMessage("Skriv beloppen i kronor, till exempel 6 300.");
        return;
      }
      if (amountMinor !== null && allowed.has(categoryId)) lines.push({ categoryId, amountMinor });
    }
    setBusy(true);
    const body = { lines: lines.map((l) => ({ category_id: l.categoryId, amount_minor: l.amountMinor })), source };
    const { status } = await putJson(`/api/budgets/${encodeURIComponent(props.periodKey)}`, body);
    setBusy(false);
    if (status === 200) props.onSaved();
    else setMessage("Det gick inte att spara budgeten. Försök igen.");
  };

  return (
    <form className="card budget-editor" aria-label="Sätt budget" onSubmit={(e) => void save(e)}>
      <h2>Sätt budget</h2>
      <p className="actions">
        <button type="button" disabled={busy} onClick={() => void copyPrevious()}>
          Kopiera {monthName(previousKey)}
        </button>
        <button type="button" disabled={busy} onClick={() => void average()}>
          Föreslå från snitt
        </button>
      </p>
      {message && <p role="alert">{message}</p>}
      <div className="budget-groups">
        {mains.map((m) => {
          const subs = subsOf(m.id);
          const isOpen = open.has(m.id);
          const warning = overflow(m.id);
          return (
            <fieldset key={m.id} className="budget-group">
              <label>
                {m.label}
                <input inputMode="decimal" placeholder="0" value={amounts.get(m.id) ?? ""} onChange={(e) => { setAmount(m.id, e.target.value); }} />
              </label>
              {subs.length > 0 && (
                <button
                  type="button"
                  className="small"
                  aria-expanded={isOpen}
                  onClick={() => {
                    const next = new Set(open);
                    if (!next.delete(m.id)) next.add(m.id);
                    setOpen(next);
                  }}
                >
                  {isOpen ? "Dölj underkategorier" : "Fördela på underkategorier"}
                </button>
              )}
              {isOpen && (
                <div className="budget-fields">
                  {subs.map((c) => (
                    <label key={c.id}>
                      {c.label.split(" › ").at(-1)}
                      <input inputMode="decimal" placeholder="0" value={amounts.get(c.id) ?? ""} onChange={(e) => { setAmount(c.id, e.target.value); }} />
                    </label>
                  ))}
                </div>
              )}
              {warning && <p className="note">{warning}</p>}
            </fieldset>
          );
        })}
      </div>
      <p className="actions">
        <button type="submit" className="primary" disabled={busy}>
          Spara
        </button>
        <button type="button" onClick={props.onClose}>
          Avbryt
        </button>
      </p>
    </form>
  );
}
