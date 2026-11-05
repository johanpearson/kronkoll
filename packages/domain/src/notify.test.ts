import { describe, expect, it } from "vitest";
import type { BudgetByMainCategory, BudgetFigures } from "./budget.ts";
import {
  NOTIFICATION_TOPICS,
  budgetOverNotices,
  consentNotice,
  parseTopics,
  subscribedTo,
  syncFailureNotice,
} from "./notify.ts";

const fig = (categoryId: string, budgetMinor: number | null, actualMinor: number): BudgetFigures => ({
  categoryId,
  budgetMinor,
  actualMinor,
  remainingMinor: budgetMinor === null ? null : budgetMinor - actualMinor,
  percent: budgetMinor === null || budgetMinor === 0 ? null : Math.round((actualMinor * 100) / budgetMinor),
  over: budgetMinor !== null && actualMinor > budgetMinor,
});

const budget = (groups: BudgetByMainCategory["groups"]): BudgetByMainCategory => ({
  period: "2026-11",
  groups,
  uncategorizedMinor: 0,
  totalBudgetMinor: 0,
  totalActualMinor: 0,
  excludedInternalMinor: 0,
});

const names = new Map([
  ["mat", "Mat"],
  ["mat-livs", "Livsmedel"],
  ["noje", "Nöje"],
  ["bil", "Bil"],
]);

describe("budgetnotis när en kategori passerar budget (KK-27-A, V-u-consent)", () => {
  it("en kategori över budget ger en notis med procent men utan belopp", () => {
    const result = budgetOverNotices({ budget: budget([{ ...fig("mat", 500_000, 520_000), subcategories: [] }]), names, alreadySent: [] });
    expect(result).toEqual([
      {
        categoryId: "mat",
        notice: { topic: "budget_over", title: "Budget överskriden", body: "Mat har passerat budget (104 %)", tag: "budget:2026-11:mat" },
      },
    ]);
    expect(result[0]?.notice.body).not.toMatch(/\d\s?\d{3}|kr/u);
  });

  it("exakt på budget och under budget ger ingen notis", () => {
    const groups = [
      { ...fig("mat", 500_000, 500_000), subcategories: [] },
      { ...fig("noje", 100_000, 20_000), subcategories: [] },
    ];
    expect(budgetOverNotices({ budget: budget(groups), names, alreadySent: [] })).toEqual([]);
  });

  it("högst en notis per kategori och period: redan skickade hoppas över", () => {
    const groups = [
      { ...fig("mat", 500_000, 600_000), subcategories: [] },
      { ...fig("noje", 100_000, 150_000), subcategories: [] },
    ];
    const result = budgetOverNotices({ budget: budget(groups), names, alreadySent: ["mat"] });
    expect(result.map((r) => r.categoryId)).toEqual(["noje"]);
    expect(result[0]?.notice.body).toBe("Nöje har passerat budget (150 %)");
  });

  it("en underkategori med egen budget får en egen notis", () => {
    const groups = [{ ...fig("mat", 500_000, 400_000), subcategories: [fig("mat-livs", 300_000, 330_000)] }];
    const result = budgetOverNotices({ budget: budget(groups), names, alreadySent: [] });
    expect(result.map((r) => [r.categoryId, r.notice.body, r.notice.tag])).toEqual([
      ["mat-livs", "Livsmedel har passerat budget (110 %)", "budget:2026-11:mat-livs"],
    ]);
  });

  it("utgifter utan budget ger ingen notis", () => {
    const groups = [{ ...fig("bil", null, 90_000), subcategories: [fig("mat-livs", null, 10_000)] }];
    expect(budgetOverNotices({ budget: budget(groups), names, alreadySent: [] })).toEqual([]);
  });

  it("budget noll med utgifter ger en notis utan procent", () => {
    const groups = [{ ...fig("bil", 0, 10_000), subcategories: [] }];
    expect(budgetOverNotices({ budget: budget(groups), names, alreadySent: [] })[0]?.notice.body).toBe("Bil har passerat budget");
  });

  it("en kategori utan namn får ett neutralt namn i stället för sitt id", () => {
    const groups = [{ ...fig("okand", 100, 200), subcategories: [] }];
    expect(budgetOverNotices({ budget: budget(groups), names, alreadySent: [] })[0]?.notice.body).toBe("En kategori har passerat budget (200 %)");
  });
});

describe("notis om upprepade synkfel (KK-27, KK-7-B)", () => {
  it("säger vilken bank och hur många gånger, utan felkoder", () => {
    expect(syncFailureNotice("c1", "Skandia")).toEqual({
      topic: "sync_failed",
      title: "Synken misslyckas",
      body: "Synken mot Skandia har misslyckats 3 gånger i rad. Öppna appen för att se mer.",
      tag: "sync:c1",
    });
  });
});

describe("samtyckespåminnelse som notis (KK-27-B)", () => {
  it("använder samma text som bannern", () => {
    expect(consentNotice("c1", "Skandia", 3, "2026-11-04")).toEqual({
      topic: "consent",
      title: "Samtycket går snart ut",
      body: "Kopplingen till Skandia går ut om 3 dagar (4 nov. 2026). Koppla om i appen.",
      tag: "consent:c1",
    });
  });
});

describe("valda notistyper", () => {
  it("alla tre typerna finns", () => {
    expect(NOTIFICATION_TOPICS).toEqual(["consent", "budget_over", "sync_failed"]);
  });

  it("tolkar en lista och tar bort dubbletter", () => {
    expect(parseTopics(["sync_failed", "consent", "sync_failed"])).toEqual(["consent", "sync_failed"]);
    expect(parseTopics([])).toEqual([]);
  });

  it.each([[null], ["consent"], [["consent", "sms"]], [[1]], [undefined]])("avvisar %j", (value) => {
    expect(parseTopics(value)).toBeNull();
  });

  it("väljer bara prenumerationer som vill ha typen", () => {
    const subs = [
      { id: "a", topics: ["consent", "budget_over"] as const },
      { id: "b", topics: ["sync_failed"] as const },
      { id: "c", topics: [] as const },
    ];
    expect(subscribedTo(subs, "budget_over").map((s) => s.id)).toEqual(["a"]);
    expect(subscribedTo(subs, "sync_failed").map((s) => s.id)).toEqual(["b"]);
  });
});
