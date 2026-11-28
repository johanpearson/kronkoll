// Börja om med kategorierna (KK-48, #251): rensa alla kategorier och regler som sätter en kategori och bygg upp nya
// från början, eller sätt tillbaka mallen. Appen räknar först hur mycket som berörs och frågar i en dialog, med knappen som
// säger vad den gör. Transaktionerna blir okategoriserade men raderas aldrig, och inget hos banken ändras. Ligger i
// farozonen längst ned.
import { useState } from "react";
import { field, postJson } from "../api.ts";
import { useToast } from "../toast.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Modal.tsx";
import { Switch } from "../ui/Switch.tsx";

interface Summary {
  readonly categories: number;
  readonly rules: number;
  readonly transactions: number;
  readonly splits: number;
  readonly budgetLines: number;
}

const count = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);

function toSummary(body: unknown): Summary | null {
  const [categories, rules, transactions, splits, budgetLines] = ["categories", "rules", "transactions", "splits", "budget_lines"].map((k) => count(field(body, k)));
  return categories === null || rules === null || transactions === null || splits === null || budgetLines === null
    ? null
    : { categories: categories ?? 0, rules: rules ?? 0, transactions: transactions ?? 0, splits: splits ?? 0, budgetLines: budgetLines ?? 0 };
}

export function ResetCategories(props: { onDone: () => void }) {
  const toast = useToast();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [template, setTemplate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await postJson("/api/categories/reset", { preview: true });
    setBusy(false);
    const next = status === 200 ? toSummary(body) : null;
    if (next) setSummary(next);
    else setError("Det gick inte att räkna vad som berörs. Försök igen.");
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    const { status } = await postJson("/api/categories/reset", { confirm: true, restore_template: template });
    setBusy(false);
    if (status === 200) {
      setSummary(null);
      toast.done(template ? "Kategorierna är återställda till mallen." : "Alla kategorier är rensade. Lägg till nya från början.");
      props.onDone();
    } else {
      setError("Det gick inte att rensa. Ingenting är ändrat. Försök igen.");
    }
  };

  const close = () => {
    if (!busy) {
      setSummary(null);
      setError(null);
    }
  };

  return (
    <>
      <p className="ui-body">Rensa alla kategorier och regler och sätt upp nya från början.</p>
      {error && summary === null && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      <Button variant="danger" block busy={busy && summary === null} onClick={() => void ask()}>
        Rensa alla kategorier
      </Button>
      <Dialog
        open={summary !== null}
        title="Rensa alla kategorier?"
        onClose={close}
        actions={
          <>
            <Button variant="danger" block busy={busy} onClick={() => void reset()}>
              Rensa alla kategorier
            </Button>
            <Button variant="quiet" block disabled={busy} onClick={close}>
              Avbryt
            </Button>
          </>
        }
      >
        {summary && (
          <p>
            {summary.categories} kategorier och {summary.rules} regler tas bort, {summary.transactions} transaktioner blir okategoriserade, {summary.splits} uppdelningar och {summary.budgetLines} budgetrader tas bort. Inga transaktioner raderas och inget hos banken ändras. Det går inte att ångra.
          </p>
        )}
        <Switch checked={template} onChange={setTemplate}>
          Sätt tillbaka mallens kategorier och regler i stället för en tom lista
        </Switch>
        {error && summary !== null && (
          <p role="alert" className="ui-field-error">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
