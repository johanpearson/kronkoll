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
    { id: "hushall", parent_id: null, name: "Hushåll", kind: "expense", archived: false },
    { id: "boende", parent_id: null, name: "Boende", kind: "expense", archived: false },
  ],
};

/** Påhittad budget (KK-13) i API:ts form. */
function budget(key: string, overrides: Record<string, unknown> = {}) {
  return {
    period: { key, start: `${key}-01`, end: `${key}-30` },
    lines: [
      { category_id: "mat", budget_minor: 630000, actual_minor: 655200, remaining_minor: -25200, percent: 104, over: true },
      { category_id: "hushall", budget_minor: 100000, actual_minor: 92000, remaining_minor: 8000, percent: 92, over: false },
      { category_id: "boende", budget_minor: 990000, actual_minor: 400000, remaining_minor: 590000, percent: 40, over: false },
    ],
    unbudgeted_minor: 164600,
    total_budget_minor: 1720000,
    total_actual_minor: 1311800,
    excluded_internal_minor: 1500000,
    spending: [],
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
    await Promise.resolve();
    await Promise.resolve();
  });
}

const rows = () => within(screen.getByRole("list", { name: "Kategorier" })).getAllByRole("listitem");

describe("budgetvyn (#33, KK-20)", () => {
  it("visar den pågående perioden med budget, utfall och kvar totalt", async () => {
    const paths = api();
    await open();
    expect(paths).toContain("/api/budgets/current");
    expect(screen.getByRole("heading", { name: "Budget" })).toBeTruthy();
    const stats = screen.getAllByRole("definition").map((d) => d.textContent);
    expect(stats).toEqual([formatSek(1720000), formatSek(1311800), formatSek(408200)]);
  });

  it("visar budget, utfall, kvar och andel per kategori, sorterat efter namn (KK-20-B)", async () => {
    api();
    await open();
    expect(rows().map((r) => r.querySelector(".tx-name")?.textContent)).toEqual(["Boende", "Hushåll", "Mat"]);
    expect(rows()[0]?.textContent).toContain(`${formatSek(400000)} av ${formatSek(990000)} · kvar ${formatSek(590000)}`);
    expect(rows()[0]?.textContent).toContain("40 %");
  });

  it("en överskriden budget står i text, inte bara i färg (KK-20-B)", async () => {
    api();
    await open();
    const mat = rows()[2];
    expect(mat?.className).toContain("over");
    expect(mat?.textContent).toContain("104 % – över");
    expect(mat?.textContent).toContain(`över med ${formatSek(25200)}`);
    expect(rows()[1]?.className).toContain("near");
  });

  it("säger att överföringar mellan egna konton inte räknas, och visar utgifter utan budget (KK-20-C)", async () => {
    api();
    await open();
    expect(screen.getByRole("note").textContent).toContain(formatSek(1500000));
    expect(screen.getByText(/Utgifter utan budget/u).textContent).toBe(`Utgifter utan budget: ${formatSek(164600)}`);
  });

  it("utan budget, överföringar eller utgifter utan budget säger vyn att ingen budget är satt", async () => {
    api((key) => [200, budget(key === "current" ? "2026-11" : key, { lines: [], unbudgeted_minor: 0, excluded_internal_minor: 0 })]);
    await open();
    expect(screen.getByText("Ingen budget är satt för perioden än.")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/Utgifter utan budget/u)).toBeNull();
  });

  it("en budget på noll kronor visar ett streck, eller Över när något har gått åt", async () => {
    api(() => [
      200,
      budget("2026-11", {
        lines: [
          { category_id: "mat", budget_minor: 0, actual_minor: 0, remaining_minor: 0, percent: null, over: false },
          { category_id: "boende", budget_minor: 0, actual_minor: 500, remaining_minor: -500, percent: null, over: true },
        ],
      }),
    ]);
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
    expect(screen.getByRole("button", { name: "Föregående period" })).toHaveProperty("disabled", true);
  });

  it("fliken Budget är markerad på sidan", async () => {
    api();
    await open();
    const tab = within(screen.getByRole("navigation", { name: "Huvudmeny" })).getByRole("link", { name: "Budget" });
    expect(tab.getAttribute("aria-current")).toBe("page");
  });
});
