// @vitest-environment jsdom
import { formatSek } from "@kronkoll/domain";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { toIncomeMonths } from "./IncomeHistory.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittade inkomster i samma form som GET /api/income (KK-13), äldst först som API:t svarar. */
const MONTHS = [
  { period: "2026-09", salary_minor: 1120000, parental_benefit_minor: 995000, other_minor: 78000 },
  { period: "2026-10", salary_minor: 3361000, parental_benefit_minor: 0, other_minor: 42000 },
  { period: "2026-11", salary_minor: 0, parental_benefit_minor: 0, other_minor: 0 },
];

function api(income: [number, unknown]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      return url.pathname === "/api/income" ? json(...income) : json(200, { items: [] });
    }),
  );
}

async function open() {
  window.history.replaceState(null, "", "/inkomst");
  await act(async () => {
    render(<App />);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

describe("Inkomst: historik (#40, KK-22-B)", () => {
  it("visar netto per månad, nyast först, med lön, föräldrapenning och övrigt", async () => {
    api([200, { months: MONTHS }]);
    await open();
    const rows = within(screen.getByRole("list", { name: "Inkomst per månad" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      `November 2026${formatSek(0)}Ingen inkomst`,
      `Oktober 2026${formatSek(3403000)}Lön ${formatSek(3361000)} · Övrigt ${formatSek(42000)}`,
      `September 2026${formatSek(2193000)}Lön ${formatSek(1120000)} · Föräldrapenning ${formatSek(995000)} · Övrigt ${formatSek(78000)}`,
    ]);
    expect(screen.getByRole("main").textContent).toContain("Netto efter skatt, så som det kommer in på kontot.");
  });

  it("säger till när inkomsterna inte går att hämta, men visar ändå ledigheten", async () => {
    api([503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta inkomsterna. Försök igen om en stund.");
    expect(screen.getByRole("heading", { name: "Planerad ledighet" })).toBeTruthy();
  });

  it("tål svar med saknade eller felaktiga fält", () => {
    expect(toIncomeMonths({})).toBeNull();
    expect(toIncomeMonths({ months: [{ salary_minor: 1 }, { period: "2026-01", salary_minor: "x" }] })).toEqual([{ period: "2026-01", salaryMinor: 0, benefitMinor: 0, otherMinor: 0 }]);
  });

  it("visar ett staplat diagram, äldst till vänster, där den största månaden fyller höjden (KK-22-B)", async () => {
    api([200, { months: MONTHS }]);
    await open();
    const chart = screen.getByRole("figure");
    expect(chart.querySelector("figcaption")?.textContent).toBe("Netto per månadLön Föräldrapenning Övrigt");
    expect(chart.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const bars = [...chart.querySelectorAll("g")].map((g) => ({
      label: g.querySelector("text")?.textContent,
      heights: ["salary", "benefit", "other"].map((c) => Number(g.querySelector(`rect.${c}`)?.getAttribute("height")).toFixed(1)),
    }));
    expect(bars).toEqual([
      { label: "SEP", heights: [(1120000 / 3403000 * 80).toFixed(1), (995000 / 3403000 * 80).toFixed(1), (78000 / 3403000 * 80).toFixed(1)] },
      { label: "OKT", heights: [(3361000 / 3403000 * 80).toFixed(1), "0.0", (42000 / 3403000 * 80).toFixed(1)] },
      { label: "NOV", heights: ["0.0", "0.0", "0.0"] },
    ]);
    const okt = chart.querySelectorAll("g")[1];
    expect(Number(okt?.querySelector("rect.other")?.getAttribute("y"))).toBeCloseTo(0);
    expect(chart.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 288 94");
    expect(chart.querySelectorAll("g")[2]?.getAttribute("transform")).toBe("translate(264 0)");
  });

  it("utan någon inkomst visas inget diagram, bara listan", async () => {
    api([200, { months: MONTHS.map((m) => ({ ...m, salary_minor: 0, parental_benefit_minor: 0, other_minor: -500 })) }]);
    await open();
    expect(screen.queryByRole("figure")).toBeNull();
    expect(within(screen.getByRole("list", { name: "Inkomst per månad" })).getAllByRole("listitem")).toHaveLength(3);
  });
});
