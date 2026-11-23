import { describe, expect, it } from "vitest";
import {
  NORMAL_MONTHS,
  allocateFreeSpending,
  categoryLevels,
  freeSpending,
  isOverPace,
  medianMinor,
  perDayMinor,
  type PeriodSpending,
} from "./guidelines.ts";
import type { BudgetPeriod } from "./period.ts";

const kr = (amount: number) => amount * 100;
const NOVEMBER: BudgetPeriod = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };

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

describe("freeSpending: utrymme efter fasta kostnader och sparmål (KK-42-B, KK-42-C)", () => {
  it("40 000 − 22 000 − 8 000 ger 10 000 kr att spendera fritt", () => {
    expect(freeSpending({ incomeMinor: kr(40_000), fixedMinor: kr(22_000), savingGoalMinor: kr(8_000) })).toEqual({
      feasible: true,
      freeMinor: kr(10_000),
      shortfallMinor: 0,
    });
  });

  it("går precis jämnt upp är det genomförbart med noll kvar", () => {
    expect(freeSpending({ incomeMinor: kr(30_000), fixedMinor: kr(22_000), savingGoalMinor: kr(8_000) })).toEqual({
      feasible: true,
      freeMinor: 0,
      shortfallMinor: 0,
    });
  });

  it("ett sparmål som inte går ihop ger underskott i stället för ett negativt utrymme", () => {
    expect(freeSpending({ incomeMinor: kr(28_000), fixedMinor: kr(22_000), savingGoalMinor: kr(8_000) })).toEqual({
      feasible: false,
      freeMinor: 0,
      shortfallMinor: kr(2_000),
    });
  });

  it("avvisar belopp som inte är heltal öre och negativa belopp", () => {
    expect(() => freeSpending({ incomeMinor: 1.5, fixedMinor: 0, savingGoalMinor: 0 })).toThrow("Belopp måste vara ett heltal i öre");
    expect(() => freeSpending({ incomeMinor: 0, fixedMinor: -1, savingGoalMinor: 0 })).toThrow("Belopp får inte vara negativa");
    expect(() => freeSpending({ incomeMinor: 0, fixedMinor: 0, savingGoalMinor: -1 })).toThrow("Belopp får inte vara negativa");
    expect(() => freeSpending({ incomeMinor: -1, fixedMinor: 0, savingGoalMinor: 0 })).toThrow("Belopp får inte vara negativa");
  });
});

describe("allocateFreeSpending: fördelning på rörliga kategorier (KK-42-B)", () => {
  it("fördelar i proportion till normalnivå och summan blir exakt utrymmet", () => {
    const result = allocateFreeSpending(kr(10_000), [
      { categoryId: "mat", normalMinor: kr(6_000) },
      { categoryId: "nöje", normalMinor: kr(3_000) },
      { categoryId: "shopping", normalMinor: kr(1_000) },
    ]);
    expect(Object.fromEntries(result)).toEqual({ mat: kr(6_000), nöje: kr(3_000), shopping: kr(1_000) });
  });

  it("delar ut överblivna ören så att summan stämmer, störst rest först", () => {
    const result = allocateFreeSpending(100, [
      { categoryId: "a", normalMinor: 1 },
      { categoryId: "b", normalMinor: 1 },
      { categoryId: "c", normalMinor: 1 },
    ]);
    expect([...result.values()].reduce((s, v) => s + v, 0)).toBe(100);
    expect(Object.fromEntries(result)).toEqual({ a: 34, b: 33, c: 33 });
  });

  it("ger lägre nivåer än normalt när utrymmet är mindre än normalnivåerna", () => {
    const result = allocateFreeSpending(kr(5_000), [
      { categoryId: "mat", normalMinor: kr(6_000) },
      { categoryId: "nöje", normalMinor: kr(4_000) },
    ]);
    expect(Object.fromEntries(result)).toEqual({ mat: kr(3_000), nöje: kr(2_000) });
  });

  it("manuella nivåer behålls och resten fördelas på de andra", () => {
    const result = allocateFreeSpending(
      kr(10_000),
      [
        { categoryId: "mat", normalMinor: kr(6_000) },
        { categoryId: "nöje", normalMinor: kr(3_000) },
        { categoryId: "shopping", normalMinor: kr(1_000) },
      ],
      new Map([["mat", kr(4_000)]]),
    );
    expect(Object.fromEntries(result)).toEqual({ mat: kr(4_000), nöje: kr(4_500), shopping: kr(1_500) });
  });

  it("en manuell nivå större än utrymmet ger noll åt de andra och aldrig negativt", () => {
    const result = allocateFreeSpending(
      kr(1_000),
      [
        { categoryId: "mat", normalMinor: kr(6_000) },
        { categoryId: "nöje", normalMinor: kr(3_000) },
      ],
      new Map([["mat", kr(2_000)]]),
    );
    expect(Object.fromEntries(result)).toEqual({ mat: kr(2_000), nöje: 0 });
  });

  it("en manuell nivå för en kategori som inte är rörlig ignoreras", () => {
    const result = allocateFreeSpending(kr(1_000), [{ categoryId: "mat", normalMinor: kr(6_000) }], new Map([["hyra", kr(9_000)]]));
    expect(Object.fromEntries(result)).toEqual({ mat: kr(1_000) });
  });

  it("en kategori med normalnivå noll får noll när någon annan har en nivå", () => {
    const result = allocateFreeSpending(kr(1_000), [
      { categoryId: "a", normalMinor: 0 },
      { categoryId: "b", normalMinor: kr(3_000) },
    ]);
    expect(Object.fromEntries(result)).toEqual({ a: 0, b: kr(1_000) });
  });

  it("överblivna ören går till de största resterna", () => {
    const shares = (amount: number, weights: number[]) =>
      [...allocateFreeSpending(amount, weights.map((normalMinor, i) => ({ categoryId: `c${String(i)}`, normalMinor }))).values()];
    expect(shares(7, [1, 2, 1])).toEqual([2, 3, 2]);
    expect(shares(2, [1, 4])).toEqual([0, 2]);
  });

  it("utan normalnivåer delas utrymmet lika, och utan kategorier blir resultatet tomt", () => {
    const result = allocateFreeSpending(kr(1_000), [
      { categoryId: "a", normalMinor: 0 },
      { categoryId: "b", normalMinor: 0 },
    ]);
    expect(Object.fromEntries(result)).toEqual({ a: kr(500), b: kr(500) });
    expect(allocateFreeSpending(kr(1_000), []).size).toBe(0);
  });
});

describe("perDayMinor: kvar per dag resten av perioden (KK-42-C)", () => {
  it("delar det som är kvar på dagarna kvar inklusive i dag", () => {
    expect(perDayMinor(kr(6_240), "2026-11-11", NOVEMBER)).toBe(kr(312));
  });

  it("rundar nedåt så att man aldrig får mer än vad som finns", () => {
    expect(perDayMinor(100, "2026-11-28", NOVEMBER)).toBe(33);
  });

  it("sista dagen är hela det som är kvar tillgängligt", () => {
    expect(perDayMinor(kr(300), "2026-11-30", NOVEMBER)).toBe(kr(300));
  });

  it("är noll om inget är kvar och efter periodens slut", () => {
    expect(perDayMinor(-kr(100), "2026-11-10", NOVEMBER)).toBe(0);
    expect(perDayMinor(kr(100), "2026-12-01", NOVEMBER)).toBe(0);
  });

  it("före periodens start räknas hela perioden", () => {
    expect(perDayMinor(kr(3_000), "2026-10-20", NOVEMBER)).toBe(kr(100));
  });
});

describe("isOverPace: över takt mot sparlägesnivån (KK-42-D)", () => {
  it("markerar en kategori som förbrukat mer än sin del av nivån hittills", () => {
    // 10 av 30 dagar gått: ett tak på 3 000 kr motsvarar 1 000 kr i takt.
    expect(isOverPace({ levelMinor: kr(3_000), actualMinor: kr(1_001), today: "2026-11-10", period: NOVEMBER })).toBe(true);
  });

  it("är inte över takt när utfallet är precis i takt eller under", () => {
    expect(isOverPace({ levelMinor: kr(3_000), actualMinor: kr(1_000), today: "2026-11-10", period: NOVEMBER })).toBe(false);
    expect(isOverPace({ levelMinor: kr(3_000), actualMinor: kr(500), today: "2026-11-10", period: NOVEMBER })).toBe(false);
  });

  it("utan nivå markeras ingenting som överskridet", () => {
    expect(isOverPace({ levelMinor: null, actualMinor: kr(9_000), today: "2026-11-10", period: NOVEMBER })).toBe(false);
  });

  it("med nivå noll är all spenderad summa över takt", () => {
    expect(isOverPace({ levelMinor: 0, actualMinor: 1, today: "2026-11-10", period: NOVEMBER })).toBe(true);
    expect(isOverPace({ levelMinor: 0, actualMinor: 0, today: "2026-11-10", period: NOVEMBER })).toBe(false);
  });

  it("efter periodens slut räknas hela nivån, och före starten ingen", () => {
    expect(isOverPace({ levelMinor: kr(3_000), actualMinor: kr(3_001), today: "2026-12-02", period: NOVEMBER })).toBe(true);
    expect(isOverPace({ levelMinor: kr(3_000), actualMinor: kr(3_000), today: "2026-12-02", period: NOVEMBER })).toBe(false);
    expect(isOverPace({ levelMinor: kr(3_000), actualMinor: kr(1), today: "2026-10-20", period: NOVEMBER })).toBe(true);
  });

  it("sista dagen är hela nivån i takt", () => {
    expect(isOverPace({ levelMinor: kr(3_000), actualMinor: kr(3_000), today: "2026-11-30", period: NOVEMBER })).toBe(false);
  });
});
