// Dela upp en transaktion på flera kategorier (#32, KK-19). Delarna skrivs i kronor utan tecken och
// får transaktionens tecken när de sparas. Vyn visar hela tiden hur mycket som är kvar att fördela,
// och uppdelningen går bara att spara när det är exakt noll (KK-19-A). Servern kontrollerar samma sak.
import { formatSek, parseAmount } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson, putJson } from "../api.ts";
import type { CategoryOption } from "./CategoryEditor.tsx";

/** Ett positivt belopp i kronor som användaren skrivit, t.ex. "1 240,50", i öre. Annars null. */
export function parseKronor(text: string): number | null {
  // \s tar även hårda mellanslag, som Intl använder mellan tusental.
  const normalized = text.replace(/\s/gu, "").replace(",", ".");
  try {
    const ore = parseAmount(normalized);
    return ore > 0 ? ore : null;
  } catch {
    return null;
  }
}

/** Öre som text för ett inmatningsfält, t.ex. 90000 → "900,00". */
const toKronorText = (ore: number) => (Math.abs(ore) / 100).toFixed(2).replace(".", ",");

interface PartInput {
  readonly key: number;
  readonly categoryId: string;
  readonly amount: string;
}

let nextKey = 0;
const emptyPart = (): PartInput => ({ key: ++nextKey, categoryId: "", amount: "" });

export function SplitEditor(props: {
  readonly transactionId: string;
  readonly amountMinor: number;
  readonly options: readonly CategoryOption[];
  /** Uppdelningen är sparad (true) eller borttagen (false). */
  readonly onSaved: (split: boolean) => void;
  readonly onClose: () => void;
}) {
  const [parts, setParts] = useState<readonly PartInput[] | null>(null);
  const [existing, setExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/transactions/${encodeURIComponent(props.transactionId)}/splits`;

  useEffect(() => {
    let current = true;
    void getJson(path).then(({ status, body }) => {
      if (!current) return;
      const saved = status === 200 ? field(body, "parts") : null;
      const loaded = Array.isArray(saved)
        ? saved.flatMap((p): PartInput[] => {
            const categoryId = field(p, "category_id");
            const amount = field(p, "amount_minor");
            return typeof categoryId === "string" && typeof amount === "number" ? [{ key: ++nextKey, categoryId, amount: toKronorText(amount) }] : [];
          })
        : [];
      setExisting(loaded.length > 0);
      setParts(loaded.length > 0 ? loaded : [emptyPart(), emptyPart()]);
    });
    return () => {
      current = false;
    };
  }, [path]);

  if (parts === null) return <p>Hämtar uppdelning…</p>;

  const total = Math.abs(props.amountMinor);
  const parsed = parts.map((p) => parseKronor(p.amount));
  const remaining = total - parsed.reduce<number>((sum, ore) => sum + (ore ?? 0), 0);
  const complete = parts.length >= 2 && parts.every((p, i) => p.categoryId !== "" && parsed[i] !== null) && remaining === 0;
  const sign = Math.sign(props.amountMinor);

  const update = (key: number, change: Partial<PartInput>) => {
    setParts(parts.map((p) => (p.key === key ? { ...p, ...change } : p)));
  };

  const send = async (body: { parts: { category_id: string; amount_minor: number }[] }) => {
    setBusy(true);
    setError(null);
    const result = await putJson(path, body);
    setBusy(false);
    if (result.status === 200) {
      props.onSaved(body.parts.length > 0);
      props.onClose();
      return;
    }
    const left = field(result.body, "remaining_minor");
    setError(
      result.status === 422 && typeof left === "number"
        ? `Delarna stämmer inte med beloppet. Kvar att fördela: ${formatSek(Math.abs(left))}.`
        : "Det gick inte att spara uppdelningen. Försök igen.",
    );
  };

  const save = () => send({ parts: parts.map((p, i) => ({ category_id: p.categoryId, amount_minor: sign * (parsed[i] ?? 0) })) });

  return (
    <div>
      {parts.map((part, i) => {
        const n = String(i + 1);
        const invalid = part.amount.trim() !== "" && parsed[i] === null;
        return (
          <p key={part.key}>
            <label>
              Kategori för del {n}{" "}
              <select value={part.categoryId} onChange={(e) => { update(part.key, { categoryId: e.target.value }); }}>
                <option value="">Välj kategori</option>
                {props.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>{" "}
            <label>
              Belopp för del {n}{" "}
              <input type="text" inputMode="decimal" value={part.amount} onChange={(e) => { update(part.key, { amount: e.target.value }); }} />
            </label>{" "}
            {parts.length > 2 && (
              <button type="button" aria-label={`Ta bort del ${n}`} onClick={() => { setParts(parts.filter((p) => p.key !== part.key)); }}>
                Ta bort
              </button>
            )}
            {invalid && <small> Belopp för del {n} är inte ett giltigt belopp.</small>}
          </p>
        );
      })}
      <p>Kvar att fördela: {formatSek(remaining)}</p>
      {error && <p role="alert">{error}</p>}
      <p>
        <button type="button" onClick={() => { setParts([...parts, emptyPart()]); }}>
          Lägg till del
        </button>{" "}
        <button type="button" className="primary" disabled={busy || !complete} onClick={() => void save()}>
          Spara uppdelning
        </button>{" "}
        {existing && (
          <button type="button" disabled={busy} onClick={() => void send({ parts: [] })}>
            Ta bort uppdelning
          </button>
        )}{" "}
        <button type="button" onClick={props.onClose}>
          Avbryt uppdelning
        </button>
      </p>
    </div>
  );
}
