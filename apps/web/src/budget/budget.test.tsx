// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { formatSek } from "@kronkoll/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = {
  items: [
    { id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false },
    { id: "mat-livsmedel", parent_id: "mat", name: "Livsmedel", kind: "expense", archived: false },
    { id: "mat-restaurang", parent_id: "mat", name: "Restaurang", kind: "expense", archived: false },
    { id: "boende", parent_id: null, name: "Boende", kind: "expense", archived: false },
    { id: "transport", parent_id: null, name: "Transport", kind: "expense", archived: false },
  ],
};

const fig = (id: string, budget: number | null, actual: number, extra: Record<string, unknown> = {}) => ({
  category_id: id,
  budget_minor: budget,
  actual_minor: actual,
  remaining_minor: budget === null ? null : budget - actual,
  percent: budget === null || budget === 0 ? null : Math.round((actual * 100) / budget),
  over: budget !== null && actual > budget,
  ...extra,
});

/** Påhittad budget (KK-13) i API:ts form. */
function budget(key: string, overrides: Record<string, unknown> = {}) {
  return {
    period: { key, start: `${key}-01`, end: `${key}-30` },
    lines: [
      { category_id: "mat", budget_minor: 630000 },
      { category_id: "boende", budget_minor: 990000 },
    ],
    groups: [
      fig("boende", 990000, 400000, { subcategories: [] }),
      fig("mat", 630000, 655200, { subcategories: [fig("mat-livsmedel", null, 520000), fig("mat-restaurang", 100000, 135200)] }),
      fig("transport", null, 92000, { subcategories: [] }),
    ],
    uncategorized_minor: 3000,
    total_budget_minor: 1620000,
    total_actual_minor: 1150200,
    excluded_internal_minor: 1500000,
    ...overrides,
  };
}

function api(respond: (key: string) => [number, unknown] = (key) => [200, budget(key === "current" ? "2026-11" : key)]) {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      paths.push(url.pathname);
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/categories") return json(200, CATEGORIES);
      const match = /^\/api\/budgets\/(.+)$/u.exec(url.pathname);
      if (match?.[1]) return json(...respond(match[1]));
      return json(404, { error: "not_found" });
    }),
  );
  return paths;
}

async function open() {
  window.history.replaceState(null, "", "/budget");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

const rows = () => within(screen.getByRole("list", { name: "Kategorier" })).getAllByRole("listitem");
const names = () => rows().map((r) => r.querySelector(".tx-name")?.textContent);

describe("budgetvyn per huvudkategori (#33, KK-20)", () => {
  it("visar den pågående perioden med budget, utfall och kvar totalt", async () => {
    const paths = api();
    await open();
    expect(paths).toContain("/api/budgets/current");
    expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual([formatSek(1620000), formatSek(1150200), formatSek(469800)]);
  });

  it("en rad per huvudkategori, där utfallet är summan av underkategorierna (KK-20-B)", async () => {
    api();
    await open();
    expect(names()).toEqual(["Boende", "Mat", "Transport"]);
    expect(rows()[0]?.textContent).toContain(`${formatSek(400000)} av ${formatSek(990000)} · kvar ${formatSek(590000)}`);
    expect(rows()[0]?.querySelector(".budget-share")?.textContent).toBe("40 %");
  });

  it("en överskriden budget står i text, och en huvudkategori utan budget visar vad som spenderats", async () => {
    api();
    await open();
    expect(rows()[1]?.className).toContain("over");
    expect(rows()[1]?.querySelector(".budget-share")?.textContent).toBe("104 % – över");
    expect(rows()[1]?.textContent).toContain(`över med ${formatSek(25200)}`);
    expect(rows()[2]?.querySelector(".budget-share")?.textContent).toBe("Ingen budget");
    expect(rows()[2]?.textContent).toContain(`${formatSek(92000)} spenderat`);
    expect(rows()[2]?.querySelector("progress")).toBeNull();
  });

  it("visar underkategorierna när man fäller ut, och döljer dem igen", async () => {
    api();
    await open();
    expect(screen.queryByRole("button", { name: /Visa underkategorier/u, expanded: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Visa underkategorier (2)" }));
    expect(names()).toEqual(["Boende", "Mat", "Livsmedel", "Restaurang", "Transport"]);
    expect(rows()[2]?.className).toContain("sub");
    // En underkategori utan egen budget ingår i huvudkategorins och märks inte.
    expect(rows()[2]?.querySelector(".budget-share")?.textContent).toBe("");
    expect(rows()[3]?.querySelector(".budget-share")?.textContent).toBe("135 % – över");
    fireEvent.click(screen.getByRole("button", { name: "Dölj underkategorier" }));
    expect(names()).toEqual(["Boende", "Mat", "Transport"]);
  });

  it("säger att överföringar mellan egna konton inte räknas, och visar okategoriserade utgifter (KK-20-C)", async () => {
    api();
    await open();
    expect(screen.getByRole("note").textContent).toContain(formatSek(1500000));
    const link = screen.getByRole("link", { name: "Okategoriserade utgifter" });
    expect(link.closest("p")?.textContent).toBe(`Okategoriserade utgifter: ${formatSek(3000)}`);
    expect(link.getAttribute("href")).toBe("/transaktioner?period=2026-11&okategoriserade=1");
  });

  it("utan budget och utgifter säger vyn att ingen budget är satt", async () => {
    api((key) => [200, budget(key === "current" ? "2026-11" : key, { lines: [], groups: [], uncategorized_minor: 0, excluded_internal_minor: 0 })]);
    await open();
    expect(screen.getByText("Ingen budget är satt för perioden än.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Kategorier" })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("en budget på noll kronor visar ett streck, eller Över när något har gått åt", async () => {
    api(() => [200, budget("2026-11", { groups: [fig("boende", 0, 500, { subcategories: [] }), fig("mat", 0, 0, { subcategories: [] })] })]);
    await open();
    expect(rows().map((r) => r.querySelector(".budget-share")?.textContent)).toEqual(["Över", "–"]);
  });

  it("bläddrar mellan perioder", async () => {
    const paths = api();
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Föregående period" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Nästa period" }));
      await Promise.resolve();
    });
    expect(paths.filter((p) => p.startsWith("/api/budgets/"))).toEqual(["/api/budgets/current", "/api/budgets/2026-10", "/api/budgets/2026-11"]);
  });

  it("säger till när budgeten inte går att hämta", async () => {
    api(() => [503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta budgeten");
  });
});
