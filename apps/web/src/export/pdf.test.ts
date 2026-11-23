// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ExportDoc } from "./export-doc.ts";
import { buildPdf, winAnsi } from "./pdf.ts";

const doc = (rows = 2): ExportDoc => ({
  title: "Budget och riktlinjer 1 nov. 2026 – 30 nov. 2026",
  fileStem: "kronkoll-budget-2026-11",
  summary: [["Läge", "Sparläge"], ["Sparmål per period", { minor: 800000 }]],
  header: ["Kategori", "Utfall", "Andel", "Status"],
  rows: Array.from({ length: rows }, (_, i) => [i === 0 ? "Mat (dagligvaror) \\ å" : `Kategori ${String(i)}`, { minor: 650000 }, { percent: i === 0 ? 108 : null }, i === 0 ? "Över" : ""]),
  totals: ["Summa", { minor: 650000 * rows }, { percent: 72 }, ""],
  note: "Kvar, andel och status räknas mot sparläget.",
});

/** PDF-filen som text i Windows-1252 (WinAnsi): ett tecken per byte, så att förskjutningarna går att kontrollera. */
async function read(blob: Blob): Promise<string> {
  return new TextDecoder("latin1").decode(await blob.arrayBuffer());
}

describe("winAnsi (KK-43-C)", () => {
  it("behåller svenska tecken och översätter minustecken, tankstreck och hårda mellanslag", () => {
    expect(winAnsi("åäöÅÄÖ é")).toBe("åäöÅÄÖ é");
    expect(winAnsi("−5 – 6 7 8")).toBe("-5 \x96 6 7 8");
  });
  it("behåller › i kategorinamn som Mat › Livsmedel som WinAnsi-tecknet", () => {
    expect(winAnsi("Mat › Livsmedel")).toBe("Mat \x9b Livsmedel");
  });
  it("ersätter tecken som typsnittet saknar med ?", () => {
    expect(winAnsi("a😀b≈")).toBe("a?b?");
  });
});

describe("buildPdf (KK-43-C)", () => {
  it("är en PDF med en sida, katalog, typsnitt och korrekta förskjutningar i xref", async () => {
    const blob = buildPdf(doc());
    expect(blob.type).toBe("application/pdf");
    const pdf = await read(blob);
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.endsWith("%%EOF\n")).toBe(true);
    expect(pdf).toContain("/Count 1");
    expect(pdf).toContain("/BaseFont /Courier ");
    expect(pdf).toContain("/BaseFont /Courier-Bold ");
    const start = Number(/startxref\n(\d+)\n/u.exec(pdf)?.[1]);
    expect(pdf.slice(start, start + 4)).toBe("xref");
    const entries = [...pdf.slice(start).matchAll(/^(\d{10}) 00000 n $/gmu)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(5);
    entries.forEach((offset, i) => {
      expect(pdf.slice(offset, offset + `${String(i + 1)} 0 obj`.length)).toBe(`${String(i + 1)} 0 obj`);
    });
  });

  it("innehåller texten, med svenska tecken som en byte och parenteser och snedstreck skyddade", async () => {
    const pdf = await read(buildPdf(doc()));
    // Byten 0x96 läses som tankstreck i Windows-1252, vilket är vad PDF-läsaren också gör.
    expect(pdf).toContain("Budget och riktlinjer 1 nov. 2026 – 30 nov. 2026");
    expect(pdf).toContain("Mat \\(dagligvaror\\) \\\\ å");
    expect(pdf).toContain("Över");
    expect(pdf).toContain("108 %");
    expect(pdf).toContain("6 500,00 kr");
  });

  it("anger längden på varje innehållsström rätt", async () => {
    const pdf = await read(buildPdf(doc()));
    for (const m of pdf.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/gu)) {
      expect(m[2]?.length).toBe(Number(m[1]));
    }
  });

  it("delar en lång tabell på flera sidor och hänvisar till alla sidor", async () => {
    const pdf = await read(buildPdf(doc(120)));
    const count = Number(/\/Count (\d+)/u.exec(pdf)?.[1]);
    expect(count).toBeGreaterThan(2);
    expect([...pdf.matchAll(/\/Type \/Page /gu)]).toHaveLength(count);
    expect(pdf).toContain("Kategori 119");
  });

  it("anpassar teckenstorleken så att en mycket bred rad ryms, men aldrig under minsta storlek", async () => {
    const narrow = await read(buildPdf(doc()));
    const wide = await read(buildPdf({ ...doc(), note: "x".repeat(400) }));
    const size = (pdf: string) => Number(/\/F1 ([\d.]+) Tf/u.exec(pdf)?.[1]);
    expect(size(narrow)).toBe(10);
    expect(size(wide)).toBe(6);
  });

  it("anpassar teckenstorleken till bredaste raden", async () => {
    const pdf = await read(buildPdf({ ...doc(), note: "x".repeat(160) }));
    const size = Number(/\/F1 ([\d.]+) Tf/u.exec(pdf)?.[1]);
    expect(size).toBeGreaterThan(6);
    expect(size).toBeLessThan(10);
  });
});
