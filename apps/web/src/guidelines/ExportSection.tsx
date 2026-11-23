// Dela eller exportera perioden (KK-43): Excel och en lättläst PDF. Filen byggs i webbläsaren av det som är
// sparat för perioden, och på en telefon öppnas delningsmenyn. Inget lämnar enheten (KK-43-B).
import { useState } from "react";
import { fetchBudget } from "../budget/BudgetView.tsx";
import { deliverFile } from "../export/deliver.ts";
import { buildExportDoc } from "../export/export-doc.ts";
import { buildPdf } from "../export/pdf.ts";
import { buildXlsx } from "../export/xlsx.ts";
import { useToast } from "../toast.tsx";
import type { Categories } from "../transactions/TransactionsView.tsx";
import type { Guidelines } from "./guidelines.ts";

type Format = "xlsx" | "pdf";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function ExportSection(props: { guidelines: Guidelines; categories: Categories; accountIds: readonly string[] }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (format: Format) => {
    setBusy(true);
    setMessage(null);
    try {
      const budget = await fetchBudget(props.guidelines.period.key, props.accountIds);
      if (!budget) {
        setMessage("Det gick inte att hämta budgeten till filen. Försök igen om en stund.");
        return;
      }
      const doc = buildExportDoc(props.guidelines, budget.groups, (id) => props.categories.names.get(id) ?? id);
      const blob = format === "xlsx" ? await buildXlsx(doc) : buildPdf(doc);
      const file = new File([blob], `${doc.fileStem}.${format}`, { type: format === "xlsx" ? XLSX_TYPE : "application/pdf" });
      const result = await deliverFile(file, doc.title);
      if (result === "shared") toast.done("Filen är delad.");
      else if (result === "downloaded") toast.done("Filen är nedladdad.");
    } catch {
      setMessage("Det gick inte att skapa filen. Försök igen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Dela eller exportera">
      <h2>Dela eller exportera</h2>
      <p>
        Budget och riktlinjer för perioden som visas, som sparade. På telefonen öppnas delningsmenyn, annars laddas filen ned. Filen skapas här på enheten.
      </p>
      <p className="actions">
        <button type="button" disabled={busy} onClick={() => void run("xlsx")}>
          Excel (.xlsx)
        </button>
        <button type="button" disabled={busy} onClick={() => void run("pdf")}>
          Lättläst sida (PDF)
        </button>
      </p>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
