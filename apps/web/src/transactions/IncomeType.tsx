// Inkomsttyp för en inbetalning (#40, KK-22-A): lön, föräldrapenning eller övrigt. Ett val sparas direkt
// med PATCH /api/transactions/{id} och lär appen en regel som också gäller tidigare inbetalningar från
// samma avsändare.
import { useState } from "react";
import { field, patchJson } from "../api.ts";
import { useToast } from "../toast.tsx";

export type IncomeType = "salary" | "parental_benefit" | "other";

export const INCOME_TYPES: readonly { value: IncomeType; label: string }[] = [
  { value: "salary", label: "Lön" },
  { value: "parental_benefit", label: "Föräldrapenning" },
  { value: "other", label: "Övrigt" },
];

const SOURCE: Record<string, string> = { template: "mall", learned: "inlärd regel", manual: "vald av dig" };

/** "Lön (vald av dig)", eller "Inte klassad". */
export function incomeLabel(type: IncomeType | null, source: string): string {
  const label = INCOME_TYPES.find((t) => t.value === type)?.label;
  return label === undefined ? "Inte klassad" : `${label} (${SOURCE[source] ?? "okänd källa"})`;
}

export function IncomeTypePicker(props: { transactionId: string; value: IncomeType | null; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Valet syns direkt och går tillbaka om det inte går att spara.
  const [selected, setSelected] = useState<IncomeType | null>(props.value);

  const choose = async (type: IncomeType) => {
    const before = selected;
    setSelected(type);
    setBusy(true);
    const { status, body } = await patchJson(`/api/transactions/${encodeURIComponent(props.transactionId)}`, { income_type: type });
    setBusy(false);
    if (status !== 200) {
      setSelected(before);
      toast.problem("Det gick inte att spara inkomsttypen. Försök igen.");
      return;
    }
    const updated = field(body, "updated");
    const others = typeof updated === "number" && updated > 0 ? ` ${String(updated)} tidigare inbetalningar fick samma typ.` : "";
    toast.done(`Inkomsttypen är sparad.${others}`);
    props.onSaved();
  };

  return (
    <fieldset className="card choices" disabled={busy}>
      <legend>Inkomsttyp</legend>
      {INCOME_TYPES.map((t) => (
        <label key={t.value}>
          <input type="radio" name="income-type" checked={selected === t.value} onChange={() => void choose(t.value)} />
          {t.label}
        </label>
      ))}
      <small>Valet gäller även tidigare och kommande inbetalningar från samma avsändare.</small>
    </fieldset>
  );
}
