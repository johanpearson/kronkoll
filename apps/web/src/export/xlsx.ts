// Excel-fil för en export (KK-43-A, KK-43-B). Biblioteket write-excel-file hämtas först när filen ska skapas, så
// att den inte tyngre startsidan. Filen byggs i webbläsaren och ingen bankdata skickas någonstans (KK-43-B).
// Text skrivs som textceller. En cell vars text börjar med =, +, - eller @ blir därför aldrig en formel i en
// .xlsx-fil (formler har en egen celltyp), men för säkerhets skull får sådan text ett inledande apostrof-
// skydd som i CSV, så att ingen import eller klistra-in-väg gör en formel av den.
import type { SheetData } from "write-excel-file/universal";
import type { Cell, ExportDoc } from "./export-doc.ts";

const MONEY_FORMAT = '#,##0.00 "kr"';
const PERCENT_FORMAT = "0%";
const HEADER_FILL = "#e8ecf2";
const OVER_COLOR = "#b00020";
const FORMULA_START = /^[=+\-@\t\r]/u;

/** Text som aldrig kan tolkas som en formel. */
export function safeText(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

type Style = { readonly fontWeight?: "bold"; readonly backgroundColor?: string; readonly textColor?: string; readonly align?: "left" | "right" };

function cell(value: Cell, style: Style = {}): SheetData[number][number] {
  if (typeof value === "string") return value === "" ? null : { value: safeText(value), type: String, ...style };
  if ("minor" in value) return { value: value.minor / 100, type: Number, format: MONEY_FORMAT, ...style };
  return value.percent === null ? null : { value: value.percent / 100, type: Number, format: PERCENT_FORMAT, ...style };
}

const text = (value: string, style: Style = {}): SheetData[number][number] => ({ value: safeText(value), type: String, ...style });

/** Arket som rader: titel, nyckeltal, tabell med summa, och en not om vad kvar och andel räknas mot. */
export function sheetFor(doc: ExportDoc): SheetData {
  const header = doc.header.map((h) => text(h, { fontWeight: "bold", backgroundColor: HEADER_FILL }));
  const body = (row: readonly Cell[], style: Style = {}) =>
    row.map((c, i) => cell(c, { ...style, ...(i === row.length - 1 && c === "Över" ? { fontWeight: "bold" as const, textColor: OVER_COLOR } : {}) }));
  return [
    [text(doc.title, { fontWeight: "bold" })],
    [],
    ...doc.summary.map(([label, value]) => [text(label, { fontWeight: "bold" }), cell(value, { align: "left" })]),
    [],
    header,
    ...doc.rows.map((r) => body(r)),
    body(doc.totals, { fontWeight: "bold" }),
    [],
    [text(doc.note)],
  ];
}

/** Excel-filen som en Blob. */
export async function buildXlsx(doc: ExportDoc): Promise<Blob> {
  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  const columns = doc.header.map((_, i) => ({ width: i === 0 ? 30 : 14 }));
  return writeXlsxFile(sheetFor(doc), { columns, sheet: "Budget" }).toBlob();
}
