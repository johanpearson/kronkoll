// Ta bort alla regler och börja om (KK-51, #251): alla kategoriserande regler, mallens och egna, och alla Räkna inte-regler.
// Appen räknar först hur många som berörs och frågar i en dialog, med knappen som säger vad den gör. Transaktionerna
// behåller sin kategori, och det som en Räkna inte-regel höll utanför räknas igen. Ligger i farozonen längst ned.
import { useState } from "react";
import { field, postJson } from "../api.ts";
import { useToast } from "../toast.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Modal.tsx";

export function ResetRules(props: { onDone: () => void }) {
  const toast = useToast();
  const [counts, setCounts] = useState<{ rules: number; exclude: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await postJson("/api/rules/reset", { preview: true });
    setBusy(false);
    const rules = field(body, "rules");
    const exclude = field(body, "exclude_rules");
    if (status === 200 && typeof rules === "number" && typeof exclude === "number") setCounts({ rules, exclude });
    else setError("Det gick inte att räkna reglerna. Försök igen.");
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    const { status } = await postJson("/api/rules/reset", { confirm: true });
    setBusy(false);
    if (status === 200) {
      setCounts(null);
      toast.done("Alla regler är borttagna.");
      props.onDone();
    } else {
      setError("Det gick inte att ta bort reglerna. Ingenting är ändrat. Försök igen.");
    }
  };

  const close = () => {
    if (!busy) {
      setCounts(null);
      setError(null);
    }
  };

  return (
    <>
      <p className="ui-body">Ta bort alla regler och sätt upp egna från början.</p>
      {error && counts === null && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      <Button variant="danger" block busy={busy && counts === null} onClick={() => void ask()}>
        Ta bort alla regler
      </Button>
      <Dialog
        open={counts !== null}
        title="Ta bort alla regler?"
        onClose={close}
        actions={
          <>
            <Button variant="danger" block busy={busy} onClick={() => void reset()}>
              Ta bort alla regler
            </Button>
            <Button variant="quiet" block disabled={busy} onClick={close}>
              Avbryt
            </Button>
          </>
        }
      >
        {counts && (
          <p>
            {counts.rules} regler som ger en kategori och {counts.exclude} regler som gör att något inte räknas tas bort. Transaktionerna behåller sin kategori, och det som reglerna höll utanför räknas igen. Det går inte att ångra.
          </p>
        )}
        {error && counts !== null && (
          <p role="alert" className="ui-field-error">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
