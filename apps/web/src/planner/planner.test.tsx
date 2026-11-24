// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { formatSek } from "@kronkoll/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = {
  items: [
    { id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false },
    { id: "boende", parent_id: null, name: "Boende", kind: "expense", archived: false },
    { id: "fritid", parent_id: null, name: "Fritid", kind: "expense", archived: false },
  ],
};

/** Påhittade underlag (KK-13): boende är fast, mat och fritid följer historiken. */
function guidelines(extra: Record<string, unknown> = {}) {
  return {
    period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
    mode: "saving",
    saving_goal_minor: 800000,
    one_off_periods: ["2026-09"],
    expected_income_minor: 4000000,
    fixed_minor: 900000,
    feasible: true,
    shortfall_minor: 0,
    free_to_spend_minor: 2300000,
    remaining_free_minor: 1700000,
    per_day_minor: 106250,
    categories: [
      { category_id: "mat", average_minor: 613333, normal_minor: 615000, fixed_minor: 0, saving_minor: 600000, override_minor: null, actual_minor: 300000, last_minor: 640000, over_pace: false },
      { category_id: "boende", average_minor: 900000, normal_minor: 900000, fixed_minor: 900000, saving_minor: 900000, override_minor: 850000, actual_minor: 0, last_minor: 900000, over_pace: false },
      { category_id: "fritid", average_minor: 385000, normal_minor: 170000, fixed_minor: 0, saving_minor: 150000, override_minor: null, actual_minor: 0, last_minor: 160000, over_pace: false },
    ],
    ...extra,
  };
}

interface Calls {
  readonly paths: string[];
  readonly guidelinePuts: unknown[];
  readonly budgetPuts: { path: string; body: unknown }[];
}

function api(options: { guidelines?: [number, unknown]; budgetLines?: number; budgetStatus?: number; budgetPutStatus?: number; guidelinePutStatus?: number } = {}): Calls {
  const calls: Calls = { paths: [], guidelinePuts: [], budgetPuts: [] };
  const lines = Array.from({ length: options.budgetLines ?? 0 }, (_, i) => ({ category_id: `k${String(i)}`, budget_minor: 100 }));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      const body = (): unknown => JSON.parse(typeof init?.body === "string" ? init.body : "null");
      calls.paths.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname === "/api/categories") return json(200, CATEGORIES);
      if (url.pathname === "/api/accounts") return json(200, { items: [] });
      if (url.pathname === "/api/guidelines") {
        if (init?.method === "PUT") {
          calls.guidelinePuts.push(body());
          return json(options.guidelinePutStatus ?? 200, { mode: "saving" });
        }
        const [status, payload] = options.guidelines ?? [200, guidelines()];
        return json(status, payload);
      }
      if (url.pathname.startsWith("/api/budgets/")) {
        if (init?.method === "PUT") {
          calls.budgetPuts.push({ path: url.pathname, body: body() });
          return json(options.budgetPutStatus ?? 200, { period: "2026-11", lines: 0 });
        }
        return json(options.budgetStatus ?? 200, {
          period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
          lines,
          groups: [],
          uncategorized_minor: 0,
          total_budget_minor: 0,
          total_actual_minor: 0,
          excluded_internal_minor: 0,
        });
      }
      return json(404, { error: "not_found" });
    }),
  );
  return calls;
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function open() {
  window.history.replaceState(null, "", "/budget/planera");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const form = () => screen.getByRole("form", { name: "Planera budget" });
const type = (label: string, value: string) => { fireEvent.change(screen.getByLabelText(label), { target: { value } }); };
const summary = () => Object.fromEntries(within(screen.getByRole("region", { name: "Summering" })).getAllByRole("term").map((t) => [t.textContent, t.nextElementSibling?.textContent]));
const rows = () => within(screen.getByRole("list", { name: "Utgifter" })).getAllByRole("listitem");
const submit = () => act(async () => { fireEvent.submit(form()); await Promise.resolve(); });

describe("Planera budget (KK-42)", () => {
  it("förifyller inkomsten med förväntad inkomst och visar ett förslag per huvudkategori ur historiken (KK-42-A, KK-42-B)", async () => {
    const { paths } = api();
    await open();
    expect(paths).toContain("GET /api/guidelines?period=current");
    expect(screen.getByLabelText<HTMLInputElement>("Belopp för Lön (kr)").value).toBe("40000");
    expect(rows().map((r) => r.querySelector(".tx-name")?.textContent)).toEqual(["Boende", "Fritid", "Mat"]);
    expect(screen.getByLabelText<HTMLInputElement>("Utgift för Mat (kr)").value).toBe("6150");
    expect(screen.getByText(/Förifylld med förväntad inkomst/u)).toBeTruthy();
  });

  it("visar förra periodens utfall, fast del och andel av inkomsten per kategori (KK-42-B)", async () => {
    api();
    await open();
    expect(rows()[0]?.textContent).toContain(`Förra perioden ${formatSek(900000)} · varav fast ${formatSek(900000)} · 23 % av inkomsten`);
    expect(rows()[0]?.querySelector(".budget-share")?.textContent).toBe("Fast");
    expect(rows()[2]?.textContent).toContain(`Förra perioden ${formatSek(640000)} · 15 % av inkomsten`);
    expect(rows()[2]?.querySelector(".budget-share")).toBeNull();
  });

  it("summerar medan man skriver: flera inkomstrader, utgifter och sparande, och vad som blir över (KK-42-A, KK-42-C)", async () => {
    api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Lägg till inkomst" }));
    const names = screen.getAllByLabelText("Namn på inkomsten");
    fireEvent.change(names[1] as HTMLElement, { target: { value: "Barnbidrag" } });
    type("Belopp för Barnbidrag (kr)", "5 000");
    type("Utgift för Mat (kr)", "30 000");
    type("Utgift för Fritid (kr)", "2 200");
    type("Sparande per månad (valfritt)", "3 000");
    expect(summary()).toEqual({
      Inkomst: formatSek(4500000),
      Utgifter: formatSek(4120000),
      Sparande: formatSek(300000),
      "Blir över": formatSek(80000),
    });
    expect(screen.queryByRole("note")).toBeNull();
    // Mer i utgifter ger ett underskott som står i text.
    type("Utgift för Mat (kr)", "32 000");
    expect(summary()["Underskott"]).toBe(formatSek(120000));
    expect(screen.getByRole("note").textContent).toBe(`Utgifterna och sparandet är ${formatSek(120000)} mer än inkomsten.`);
  });

  it("en inkomstrad går att ta bort, och utan inkomst står det vad man ska göra", async () => {
    api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ta bort Lön" }));
    expect(screen.getByText("Lägg till en inkomst för att se vad som blir över.")).toBeTruthy();
    expect(summary()["Inkomst"]).toBe(formatSek(0));
    expect(rows()[0]?.textContent).not.toContain("av inkomsten");
  });

  it("utkastet finns kvar efter omladdning och rensas av Återställ förslaget (KK-42-D)", async () => {
    api();
    await open();
    type("Utgift för Mat (kr)", "7 000");
    type("Sparande per månad (valfritt)", "1 000");
    type("Belopp för Lön (kr)", "41 000");
    cleanup();
    await open();
    expect(screen.getByLabelText<HTMLInputElement>("Utgift för Mat (kr)").value).toBe("7 000");
    expect(screen.getByLabelText<HTMLInputElement>("Sparande per månad (valfritt)").value).toBe("1 000");
    expect(screen.getByLabelText<HTMLInputElement>("Belopp för Lön (kr)").value).toBe("41 000");
    fireEvent.click(screen.getByRole("button", { name: "Återställ förslaget" }));
    expect(screen.getByLabelText<HTMLInputElement>("Utgift för Mat (kr)").value).toBe("6150");
    expect(screen.getByLabelText<HTMLInputElement>("Belopp för Lön (kr)").value).toBe("40000");
    expect(window.localStorage.getItem("kronkoll.plan.2026-11")).toBeNull();
  });

  it("sparar planen som periodens budget per huvudkategori utan sparandet, och rensar utkastet (KK-42-D)", async () => {
    const calls = api();
    await open();
    type("Utgift för Fritid (kr)", "0");
    type("Sparande per månad (valfritt)", "3 000");
    await submit();
    await settle();
    expect(calls.budgetPuts).toEqual([
      { path: "/api/budgets/2026-11", body: { lines: [{ category_id: "boende", amount_minor: 900000 }, { category_id: "mat", amount_minor: 615000 }], source: "manual" } },
    ]);
    expect(screen.getByRole("status").textContent).toBe("Budgeten för perioden är sparad.");
    expect(window.localStorage.getItem("kronkoll.plan.2026-11")).toBeNull();
    expect(calls.paths.filter((p) => p === "GET /api/guidelines?period=current")).toHaveLength(2);
  });

  it("finns det redan en budget frågar appen först, och Avbryt sparar ingenting", async () => {
    const calls = api({ budgetLines: 3 });
    await open();
    await submit();
    await settle();
    const ask = screen.getByRole("region", { name: "Ersätt budgeten" });
    expect(ask.textContent).toContain("redan en budget med 3 kategorier");
    expect(calls.budgetPuts).toEqual([]);
    fireEvent.click(within(ask).getByRole("button", { name: "Avbryt" }));
    expect(screen.queryByRole("region", { name: "Ersätt budgeten" })).toBeNull();
    expect(calls.budgetPuts).toEqual([]);
  });

  it("Ersätt budgeten sparar planen över den gamla", async () => {
    const calls = api({ budgetLines: 3 });
    await open();
    await submit();
    await settle();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("region", { name: "Ersätt budgeten" })).getByRole("button", { name: "Ersätt budgeten" }));
      await Promise.resolve();
    });
    await settle();
    expect(calls.budgetPuts).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Budgeten för perioden är sparad.");
  });

  it("ändrar man planen medan frågan står uppe försvinner frågan", async () => {
    api({ budgetLines: 3 });
    await open();
    await submit();
    await settle();
    type("Utgift för Mat (kr)", "5 000");
    expect(screen.queryByRole("region", { name: "Ersätt budgeten" })).toBeNull();
  });

  it("ett belopp som inte är ett belopp sparas inte och markeras", async () => {
    const calls = api();
    await open();
    type("Utgift för Mat (kr)", "mycket");
    expect(screen.getByLabelText("Utgift för Mat (kr)").getAttribute("aria-invalid")).toBe("true");
    await submit();
    expect(screen.getByRole("alert").textContent).toContain("Skriv beloppen i kronor");
    expect(calls.budgetPuts).toEqual([]);
  });

  it("fel vid kontroll av budgeten eller vid sparande står i text", async () => {
    api({ budgetStatus: 500 });
    await open();
    await submit();
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att kontrollera periodens budget");
    cleanup();
    api({ budgetPutStatus: 503 });
    await open();
    await submit();
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att spara budgeten");
  });

  it("en engångsperiod sparas direkt och förslagen hämtas om, med läge, sparmål och egna nivåer oförändrade (KK-42-E)", async () => {
    const calls = api();
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: /augusti 2026/u }));
    await settle();
    expect(calls.guidelinePuts).toEqual([
      { mode: "saving", saving_goal_minor: 800000, overrides: [{ category_id: "boende", amount_minor: 850000 }], one_off_periods: ["2026-08", "2026-09"] },
    ]);
    expect(calls.paths.filter((p) => p === "GET /api/guidelines?period=current")).toHaveLength(2);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /september 2026/u }).checked).toBe(true);
  });

  it("en markerad engångsperiod går att ta bort igen, och ett fel står i text", async () => {
    const calls = api({ guidelinePutStatus: 500 });
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: /september 2026/u }));
    await settle();
    expect((calls.guidelinePuts[0] as { one_off_periods: string[] }).one_off_periods).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att spara engångsperioden");
  });

  it("utan historik står det, och felet vid hämtning visas", async () => {
    api({ guidelines: [200, guidelines({ categories: [], expected_income_minor: 0 })] });
    await open();
    expect(screen.getByText(/Det finns ingen historik att ta förslag ur än/u)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Belopp för Lön (kr)").value).toBe("");
    expect(screen.queryByText(/Förifylld med förväntad inkomst/u)).toBeNull();
    cleanup();
    api({ guidelines: [500, { error: "unavailable" }] });
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta underlaget till planen");
  });

  it("Budget är markerad i menyn, och föregående period hämtas", async () => {
    const calls = api();
    await open();
    expect(screen.getByRole("link", { name: "Budget" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Föregående period" }));
    await settle();
    expect(calls.paths.at(-1)).toContain("period=2026-10");
  });
});
