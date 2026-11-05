// @vitest-environment jsdom
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { toInsights } from "./InsightsView.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = {
  items: [
    { id: "mat", name: "Mat", parent_id: null, kind: "expense" },
    { id: "mat-restaurang", name: "Restaurang & café", parent_id: "mat", kind: "expense" },
    { id: "boende", name: "Boende", parent_id: null, kind: "expense" },
  ],
};

/** Påhittade insikter i samma form som GET /api/insights (KK-13). */
const INSIGHTS = {
  period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
  history_periods: ["2026-10", "2026-09", "2026-08"],
  anomalies: [
    { category_id: "mat-restaurang", actual_minor: 375_000, baseline_minor: 257_000, diff_minor: 118_000, pct: 46 },
    { category_id: "barn-klader", actual_minor: 60_000, baseline_minor: 0, diff_minor: 60_000, pct: null },
  ],
  recurring: [
    { name: "Hyresvärden AB", interval: "monthly", amount_minor: 890_000, last_date: "2026-11-01", next_expected: "2026-12-01", yearly_minor: 10_680_000, occurrences: 4 },
    { name: "<b>Försäkring</b>", interval: "yearly", amount_minor: 234_000, last_date: "2026-02-03", next_expected: "2027-02-03", yearly_minor: 234_000, occurrences: 2 },
  ],
  recurring_yearly_minor: 10_914_000,
  top_expenses: [
    { id: "t1", date: "2026-11-01", name: "Hyresvärden AB", amount_minor: 890_000, category_id: "boende", split: false },
    { id: "t2", date: "2026-11-09", name: "", amount_minor: 124_000, category_id: "mat-restaurang", split: true },
  ],
  top_categories: ["boende", "mat", null, "a", "b", "c"].map((id, i) => ({ category_id: id, amount_minor: 900_000 - i * 100_000 })),
};

function api(insights: [number, unknown] = [200, INSIGHTS]) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const [status, body] = url.pathname === "/api/insights" ? (asked.push(url.search), insights) : url.pathname === "/api/categories" ? [200, CATEGORIES] : [503, {}];
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
  return asked;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function open(path = "/insikter") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const items = (name: string) => within(screen.getByRole("list", { name })).getAllByRole("listitem").map((li) => li.textContent);

describe("Insikter (#41, KK-24)", () => {
  it("visar avvikelser mot snittet med procent, och ny utgift utan procent (KK-24-B)", async () => {
    api();
    await open();
    expect(items("Avvikelser")).toEqual([
      ` Mat › Restaurang & café+46 %, +${formatSek(118_000)}${formatSek(375_000)} mot snitt ${formatSek(257_000)}`,
      ` barn-kladerNy, +${formatSek(60_000)}${formatSek(60_000)} mot snitt ${formatSek(0)}`,
    ]);
  });

  it("visar återkommande dragningar med nästa datum och årskostnad, och banktext som text (KK-24-A, KK-30)", async () => {
    api();
    await open();
    expect(screen.getByRole("main").textContent).toContain(`Ungefär ${formatSek(10_914_000)} per år.`);
    expect(items("Återkommande dragningar")).toEqual([
      `Hyresvärden AB${formatSek(890_000)}/månMånadsvis, ${formatSek(10_680_000)}/år · nästa ≈ ${formatDateShort("2026-12-01")}`,
      `<b>Försäkring</b>${formatSek(234_000)}/årÅrsvis · nästa ≈ ${formatDateShort("2027-02-03")}`,
    ]);
    expect(document.querySelector("main b")).toBeNull();
  });

  it("visar största utgifterna med länk till transaktionen, och de fem största kategorierna med resten bakom en knapp (KK-24-C)", async () => {
    api();
    await open();
    expect(items("Största utgifter")).toEqual([`Hyresvärden AB${formatSek(890_000)}Boende`, `Okänd mottagare${formatSek(124_000)}Uppdelad, mest Mat › Restaurang & café`]);
    expect(screen.getByRole("link", { name: "Hyresvärden AB" }).getAttribute("href")).toBe("/transaktioner/t1");
    expect(items("Utgifter per kategori").map((t) => t.trim())).toEqual([`Boende${formatSek(900_000)}`, `Mat${formatSek(800_000)}`, `Okategoriserat${formatSek(700_000)}`, `a${formatSek(600_000)}`, `b${formatSek(500_000)}`]);
    fireEvent.click(screen.getByRole("button", { name: "Visa alla 6" }));
    expect(items("Utgifter per kategori")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Visa de fem största" }));
    expect(items("Utgifter per kategori")).toHaveLength(5);
  });

  it("hör till Översikt i menyn och byter period med pilarna", async () => {
    const asked = api();
    await open();
    expect(screen.getByRole("link", { name: "Översikt", current: "page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Föregående period" }));
    await settle();
    expect(asked).toEqual(["", "?period=2026-10"]);
  });

  it("säger när det inte finns något att visa, och när hämtningen misslyckas", async () => {
    api([200, { period: INSIGHTS.period, anomalies: [], recurring: [], top_expenses: [], top_categories: [] }]);
    await open();
    const text = screen.getByRole("main").textContent;
    expect(text).toContain("Ingen kategori ligger mer än 30 % och 500 kr över snittet");
    expect(text).toContain("Inga återkommande dragningar hittade.");
    expect(text).toContain("Inga utgifter i perioden.");
    expect(text).not.toContain("Utgifter per kategori");
    cleanup();
    api([503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta insikterna. Försök igen om en stund.");
  });

  it("tål svar med saknade fält", () => {
    expect(toInsights({})).toBeNull();
    expect(toInsights({ period: INSIGHTS.period, anomalies: [{ pct: 1.5 }], recurring: [{}], top_expenses: [{}], top_categories: [{}] })).toEqual({
      period: INSIGHTS.period,
      anomalies: [{ categoryId: "", actualMinor: 0, baselineMinor: 0, diffMinor: 0, pct: null }],
      recurring: [{ name: "", yearly: false, amountMinor: 0, nextExpected: "", yearlyMinor: 0 }],
      recurringYearlyMinor: 0,
      topExpenses: [{ id: "", name: "", amountMinor: 0, categoryId: null, split: false }],
      topCategories: [{ categoryId: null, amountMinor: 0 }],
    });
  });
});
