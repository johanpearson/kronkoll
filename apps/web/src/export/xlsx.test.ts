// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ExportDoc } from "./export-doc.ts";
import { buildXlsx, safeText, sheetFor } from "./xlsx.ts";

/** Ett påhittat dokument (KK-13). */
const doc: ExportDoc = {
  title: "Budget 1 nov. 2026 – 30 nov. 2026",
  fileStem: "kronkoll-budget-2026-11",
  summary: [["Period", "1 nov. 2026 – 30 nov. 2026"], ["Sparmål per period", { minor: 800000 }]],
  header: ["Kategori", "Budget", "Utfall", "Andel", "Status"],
  rows: [["=SUMMA(A1)", "", { minor: 650000 }, { percent: 108 }, "Över"], ["Boende", { minor: 900000 }, { minor: 0 }, { percent: null }, ""]],
  totals: ["Summa", { minor: 900000 }, { minor: 650000 }, { percent: 72 }, ""],
  note: "Kvar, andel och status räknas mot sparläget.",
};

describe("sheetFor (KK-43-A, KK-43-B)", () => {
  const sheet = sheetFor(doc);

  it("har titel, nyckeltal, rubrikrad, kategorier, summa och en not", () => {
    expect(sheet.map((r) => r.length)).toEqual([1, 0, 2, 2, 0, 5, 5, 5, 5, 0, 1]);
    expect(sheet[0]?.[0]).toMatchObject({ value: doc.title, fontWeight: "bold" });
    expect(sheet[5]?.map((c) => (c as { value: string }).value)).toEqual(["Kategori", "Budget", "Utfall", "Andel", "Status"]);
    expect(sheet[5]?.[0]).toMatchObject({ fontWeight: "bold", backgroundColor: "#e8ecf2" });
    expect(sheet[8]?.[0]).toMatchObject({ value: "Summa", fontWeight: "bold" });
    expect(sheet.at(-1)?.[0]).toMatchObject({ value: doc.note });
  });

  it("belopp är riktiga tal i kronor med kronformat och andelar är tal med procentformat", () => {
    expect(sheet[3]?.[1]).toMatchObject({ value: 8000, type: Number, format: '#,##0.00 "kr"' });
    expect(sheet[6]?.[3]).toMatchObject({ value: 1.08, type: Number, format: "0%" });
    expect(sheet[6]?.[2]).toMatchObject({ value: 6500 });
  });

  it("tomma celler och andelar som inte går att räkna blir tomma", () => {
    expect(sheet[6]?.[1]).toBeNull();
    expect(sheet[7]?.[3]).toBeNull();
    expect(sheet[7]?.[4]).toBeNull();
  });

  it("Över står som text och är dessutom fet och röd, och en kategori som börjar med = skyddas mot formler (KK-43-B)", () => {
    expect(sheet[6]?.[4]).toMatchObject({ value: "Över", fontWeight: "bold", textColor: "#b00020" });
    expect(sheet[6]?.[0]).toMatchObject({ value: "'=SUMMA(A1)", type: String });
  });
});

describe("safeText (KK-43-B)", () => {
  it.each(["=1+1", "+1", "-1", "@SUMMA", "\tx", "\rx"])("skyddar %j", (value) => {
    expect(safeText(value)).toBe(`'${value}`);
  });
  it.each(["Mat", "", "1 + 1", "a=b"])("lämnar %j", (value) => {
    expect(safeText(value)).toBe(value);
  });
});

describe("buildXlsx", () => {
  it("ger en riktig .xlsx-fil, alltså ett zip-arkiv", async () => {
    const blob = await buildXlsx(doc);
    expect(blob.size).toBeGreaterThan(1000);
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
