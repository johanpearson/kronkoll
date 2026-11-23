// En lättläst PDF av en export (KK-43-C), skriven för hand utan bibliotek: en tabell i en jämnbred
// typsnittsfamilj (Courier) på liggande A4, så att kolumnerna linjerar och texten går att läsa på en
// telefon. PDF:en bygger bara på sidor, text och standardtypsnitt. Tecken som typsnittet inte har blir ?.
import { formatSek } from "@kronkoll/domain";
import type { Cell, ExportDoc } from "./export-doc.ts";

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 40;
const MAX_SIZE = 10;
const MIN_SIZE = 6;
/** Courier är jämnbred: varje tecken är 0,6 gånger teckenstorleken. */
const CHAR_WIDTH = 0.6;

/** Tecken utanför Latin-1 som WinAnsi ändå har, och sådana som ska bli vanliga tecken. */
const REPLACEMENTS: Record<string, string> = { "–": "\x96", "—": "\x97", "’": "\x92", "›": "\x9b", "€": "\x80", "−": "-", " ": " ", " ": " " };

/** Texten som bytes i WinAnsi: ett tecken per byte. */
export function winAnsi(text: string): string {
  return Array.from(text, (ch) => REPLACEMENTS[ch] ?? (ch.charCodeAt(0) < 256 ? ch : "?")).join("");
}

const escapePdf = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");

function show(cell: Cell): string {
  if (typeof cell === "string") return cell;
  if ("minor" in cell) return formatSek(cell.minor);
  return cell.percent === null ? "–" : `${String(cell.percent)} %`;
}

interface Line {
  readonly text: string;
  readonly bold: boolean;
}

/** Tabellens kolumner linjerade: text till vänster, belopp och andelar till höger. */
function tableLines(doc: ExportDoc): Line[] {
  const all = [doc.header.map(String), ...doc.rows.map((r) => r.map(show)), doc.totals.map(show)];
  const widths = doc.header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const lineOf = (cells: readonly string[], numeric: boolean) =>
    cells.map((c, i) => (i === 0 || !numeric ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");
  return [
    { text: lineOf(all[0] ?? [], false), bold: true },
    ...doc.rows.map((_, i) => ({ text: lineOf(all[i + 1] ?? [], true), bold: false })),
    { text: lineOf(all.at(-1) ?? [], true), bold: true },
  ];
}

/** Alla rader i dokumentet i ordning: titel, nyckeltal, tabell och not, med tomma rader emellan. */
function documentLines(doc: ExportDoc): Line[] {
  const labelWidth = Math.max(...doc.summary.map(([label]) => label.length));
  return [
    { text: doc.title, bold: true },
    { text: "", bold: false },
    ...doc.summary.map(([label, value]): Line => ({ text: `${label.padEnd(labelWidth)}  ${show(value)}`, bold: false })),
    { text: "", bold: false },
    ...tableLines(doc),
    { text: "", bold: false },
    { text: doc.note, bold: false },
  ];
}

/** PDF-filen som en Blob. Raderna delas på sidor, och teckenstorleken anpassas så att den bredaste raden ryms. */
export function buildPdf(doc: ExportDoc): Blob {
  const lines = documentLines(doc).map((l) => ({ ...l, text: winAnsi(l.text) }));
  const widest = Math.max(...lines.map((l) => l.text.length));
  const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, (PAGE_WIDTH - 2 * MARGIN) / (CHAR_WIDTH * widest)));
  const leading = size * 1.45;
  const perPage = Math.max(1, Math.floor((PAGE_HEIGHT - 2 * MARGIN) / leading));
  const pages = Array.from({ length: Math.ceil(lines.length / perPage) }, (_, p) => lines.slice(p * perPage, (p + 1) * perPage));

  const content = (pageLines: readonly Line[]) =>
    pageLines
      .map((l, i) => `BT /${l.bold ? "F2" : "F1"} ${size.toFixed(2)} Tf ${String(MARGIN)} ${(PAGE_HEIGHT - MARGIN - size - i * leading).toFixed(2)} Td (${escapePdf(l.text)}) Tj ET`)
      .join("\n");

  // Objekt 1 katalog, 2 sidträd, 3 och 4 typsnitt, sedan en sida och dess innehåll per sida.
  const pageObject = (p: number) => 5 + 2 * p;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, p) => `${String(pageObject(p))} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>",
    ...pages.flatMap((pageLines, p) => {
      const stream = content(pageLines);
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${String(pageObject(p) + 1)} 0 R >>`,
        `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];

  let file = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = file.length;
    file += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = file.length;
  file += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  file += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new Blob([Uint8Array.from(file, (ch) => ch.charCodeAt(0))], { type: "application/pdf" });
}
