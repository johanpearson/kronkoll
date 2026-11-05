// @vitest-environment jsdom
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { toLeavePlan } from "./IncomeView.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const month = (period: string, income: number, delta: number, fallback = false) => ({
  period, leave_days: 22, withdrawal_days: 22, benefit_gross_minor: 0, topup_gross_minor: 0, net_minor: income, source: "estimate",
  params_year: 2027, params_fallback: fallback, income_minor: income, delta_vs_normal_minor: delta,
});

/** Påhittad ledighet i samma form som GET /api/leave-periods (KK-13). */
const LEAVE = {
  id: "l1", from: "2027-03-01", to: "2027-08-31", days_per_week: 5, sgi_annual_minor: 54000000, employer_topup_pct: 10, tax_rate_pct: 31.5, override_net_monthly_minor: null,
  estimate: { disclaimer: "Uppskattning – inte ett besked från Försäkringskassan", normal_net_monthly_minor: 3361000, months: [month("2027-03", 2014000, -1347000), month("2027-04", 2014000, -1347000)] },
  impacts: [
    { type: "budget", period: "2027-03", budget_minor: 3200000, income_minor: 2014000, shortfall_minor: 1186000 },
    { type: "budget", period: "2027-04", budget_minor: 3200000, income_minor: 2014000, shortfall_minor: 1186000 },
    { type: "goal", goal_id: "g1", name: "Resa till Japan", shortfall_minor: 9999999, delay_months: 3 },
  ],
};

function api(status = 200, body: unknown = { items: [LEAVE] }) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))));
}

async function open() {
  window.history.replaceState(null, "", "/inkomst");
  await act(async () => {
    render(<App />);
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

describe("Inkomst: planerad ledighet (#40, KK-23)", () => {
  it("visar perioden, snittinkomsten, minskningen mot en vanlig månad och underskottet mot budgeten", async () => {
    api();
    await open();
    expect(screen.getByRole("heading", { level: 1, name: "Inkomst" })).toBeTruthy();
    const row = within(screen.getByRole("list", { name: "Planerade perioder" })).getByRole("listitem");
    expect(row.textContent).toContain(`${formatDateShort("2027-03-01")} – ${formatDateShort("2027-08-31")}`);
    expect(row.textContent).toContain(`≈ ${formatSek(2014000)}/mån`);
    expect(row.textContent).toContain("5 dagar/vecka · föräldralön 10 %");
    const badges = [...row.querySelectorAll(".badge")].map((b) => [b.className, b.textContent]);
    expect(badges).toEqual([
      ["badge warn", `${formatSek(-1347000)}/mån mot en vanlig månad`],
      ["badge bad", `Underskott mot budget upp till ${formatSek(1186000)}/mån`],
    ]);
    expect(screen.getByRole("note").textContent).toBe("Uppskattning – inte ett besked från Försäkringskassan. Beloppen är netto efter skatt.");
  });

  it("inget underskott eller ingen minskning ger inga etiketter, och ett saknat år sägs ut", async () => {
    api(200, { items: [{ ...LEAVE, days_per_week: 2.5, employer_topup_pct: 0, impacts: [], estimate: { ...LEAVE.estimate, months: [month("2028-01", 3400000, 0, true)] } }] });
    await open();
    const row = within(screen.getByRole("list", { name: "Planerade perioder" })).getByRole("listitem");
    expect(row.querySelector(".badge")).toBeNull();
    expect(row.textContent).toContain("2,5 dagar/vecka");
    expect(row.textContent).not.toContain("föräldralön");
    expect(row.textContent).toContain("det senaste kända året används");
  });

  it("utan planerad ledighet, och när den inte går att hämta", async () => {
    api(200, { items: [] });
    await open();
    expect(screen.getByRole("main").textContent).toContain("Ingen ledighet är planerad.");
    cleanup();
    api(503, { error: "unavailable" });
    await open();
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain("Det gick inte att hämta den planerade ledigheten. Försök igen om en stund.");
  });

  it("Inkomst finns i menyn och är markerad", async () => {
    api();
    await open();
    expect(within(screen.getByRole("navigation", { name: "Huvudmeny" })).getByRole("link", { name: "Inkomst" }).getAttribute("aria-current")).toBe("page");
  });

  it("tål svar med saknade fält", () => {
    expect(toLeavePlan({ from: "2027-01-01" })).toBeNull();
    expect(toLeavePlan({ id: "x", from: "2027-01-01", to: "2027-02-01" })).toEqual({
      id: "x", from: "2027-01-01", to: "2027-02-01", daysPerWeek: 0, topupPct: 0, disclaimer: "Uppskattning – inte ett besked från Försäkringskassan",
      averageIncomeMinor: 0, averageDeltaMinor: 0, worstShortfallMinor: 0, fallbackYears: false,
    });
  });
});
