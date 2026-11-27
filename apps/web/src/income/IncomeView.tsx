// Inkomst (#40, KK-22): inkomsthistoriken per månad (IncomeHistory). Planeringen av föräldraledighet
// (KK-23) togs bort 2026-11-27 (#243).
import { IncomeHistory } from "./IncomeHistory.tsx";

export function IncomeView() {
  return (
    <main>
      <h1>Inkomst</h1>
      <IncomeHistory />
    </main>
  );
}
