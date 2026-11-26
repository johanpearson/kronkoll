import { describe, expect, it } from "vitest";
import { NORMAL_MONTHS, categoryLevels, medianMinor, rollUpToMain, type PeriodSpending } from "./guidelines.ts";

const kr = (amount: number) => amount * 100;

/** Påhittade utgifter per period (KK-13). */
const month = (key: string, entries: readonly [string | null, number][]): PeriodSpending => ({
  key,
  spending: new Map(entries.map(([c, a]) => [c, kr(a)])),
});

describe("medianMinor (KK-42-A)", () => {
  it("tar mittenvärdet av ett udda antal", () => {
    expect(medianMinor([kr(900), kr(100), kr(300)])).toBe(kr(300));
  });

  it("tar medelvärdet av de två mittersta, avrundat till hela ören", () => {
    expect(medianMinor([kr(100), kr(200), kr(300), kr(400)])).toBe(kr(250));
    expect(medianMinor([1, 2])).toBe(2);
    expect(medianMinor([1, 4])).toBe(3);
  });

  it("ändrar inte indata", () => {
    const input = [3, 1, 2];
    medianMinor(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("ger noll för en tom lista", () => {
    expect(medianMinor([])).toBe(0);
  });
});

describe("categoryLevels: historiskt snitt och normalt (KK-42-A)", () => {
  const history = [
    month("2026-05", [["mat", 6_000], ["shopping", 1_500]]),
    month("2026-06", [["mat", 6_200], ["shopping", 1_800]]),
    month("2026-07", [["mat", 5_800], ["shopping", 1_200]]),
    month("2026-08", [["mat", 6_100], ["shopping", 2_000]]),
    month("2026-09", [["mat", 6_300], ["shopping", 15_000]]),
    month("2026-10", [["mat", 6_400], ["shopping", 1_600]]),
  ];

  it("normalnivån är medianen, så en extrem månad styr inte", () => {
    const shopping = categoryLevels(history, []).find((l) => l.categoryId === "shopping");
    expect(shopping?.normalMinor).toBe(kr(1_700));
    expect(shopping?.averageMinor).toBe(kr(3_850));
  });

  it("en månad markerad som engångsperiod lämnas utanför normalnivån men inte utanför snittet", () => {
    const shopping = categoryLevels(history, ["2026-09"]).find((l) => l.categoryId === "shopping");
    expect(shopping?.normalMinor).toBe(kr(1_600));
    expect(shopping?.averageMinor).toBe(kr(3_850));
  });

  it("räknar bara de senaste 6 månaderna", () => {
    expect(NORMAL_MONTHS).toBe(6);
    const longer = [month("2026-01", [["mat", 90_000]]), month("2026-02", [["mat", 90_000]]), ...history];
    const mat = categoryLevels(longer, []).find((l) => l.categoryId === "mat");
    expect(mat?.normalMinor).toBe(kr(6_150));
    expect(mat?.averageMinor).toBe(613_333);
  });

  it("en kategori som saknas en månad räknas som noll den månaden", () => {
    const sparse = [month("2026-08", [["resor", 3_000]]), month("2026-09", []), month("2026-10", [])];
    const resor = categoryLevels(sparse, []).find((l) => l.categoryId === "resor");
    expect(resor?.normalMinor).toBe(0);
    expect(resor?.averageMinor).toBe(kr(1_000));
  });

  it("sorterar historiken själv och ignorerar okategoriserat", () => {
    const shuffled = [...history].reverse().concat(month("2026-11", [[null, 500]]));
    const levels = categoryLevels(shuffled, []);
    expect(levels.map((l) => l.categoryId)).toEqual(["mat", "shopping"]);
  });

  it("räknar de senaste 6 månaderna även när historiken ges i fel ordning", () => {
    const old = [month("2026-01", [["mat", 90_000]]), month("2026-02", [["mat", 90_000]])];
    const mat = categoryLevels([...history, ...old], []).find((l) => l.categoryId === "mat");
    expect(mat?.normalMinor).toBe(kr(6_150));
  });

  it("sorterar kategorierna på id oavsett i vilken ordning de förekommer", () => {
    const levels = categoryLevels([month("2026-10", [["z", 100], ["a", 100], ["m", 100]])], []);
    expect(levels.map((l) => l.categoryId)).toEqual(["a", "m", "z"]);
  });

  it("ger inga nivåer utan historik, eller när alla månader är engångsperioder", () => {
    expect(categoryLevels([], [])).toEqual([]);
    expect(categoryLevels(history, history.map((h) => h.key)).every((l) => l.normalMinor === 0)).toBe(true);
  });
});

describe("rollUpToMain: underkategorier summeras uppåt till huvudkategorin (KK-42)", () => {
  const parentOf = new Map<string, string | null>([["mat", null], ["mat-livsmedel", "mat"], ["mat-restaurang", "mat"], ["boende", null]]);

  it("summerar en underkategori in i sin huvudkategori och låter huvudkategorins egna belopp vara kvar", () => {
    const result = rollUpToMain(new Map([["mat", 100], ["mat-livsmedel", 600], ["mat-restaurang", 50], ["boende", 900]]), parentOf);
    expect(Object.fromEntries(result)).toEqual({ mat: 750, boende: 900 });
  });

  it("en underkategori utan egen rad i huvudkategorin ger ändå huvudkategorin", () => {
    expect(Object.fromEntries(rollUpToMain(new Map([["mat-livsmedel", 600]]), parentOf))).toEqual({ mat: 600 });
  });

  it("okategoriserat och kategorier som inte finns i trädet behålls som de är", () => {
    const result = rollUpToMain(new Map<string | null, number>([[null, 300], ["okand", 40]]), parentOf);
    expect(result.get(null)).toBe(300);
    expect(result.get("okand")).toBe(40);
  });

  it("ger tomt för tomt och ändrar inte indata", () => {
    expect(rollUpToMain(new Map(), parentOf).size).toBe(0);
    const input = new Map([["mat-livsmedel", 600]]);
    rollUpToMain(input, parentOf);
    expect([...input]).toEqual([["mat-livsmedel", 600]]);
  });
});
