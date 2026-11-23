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
    { id: "boende", parent_id: null, name: "Boende", kind: "expense", archived: false },
    { id: "fritid", parent_id: null, name: "Fritid", kind: "expense", archived: false },
  ],
};

/** Påhittade riktlinjer (KK-13). */
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
      { category_id: "boende", average_minor: 900000, normal_minor: 900000, fixed_minor: 900000, saving_minor: 900000, override_minor: null, actual_minor: 0, over_pace: false },
      { category_id: "fritid", average_minor: 385000, normal_minor: 170000, fixed_minor: 0, saving_minor: 498089, override_minor: 200000, actual_minor: 300000, over_pace: true },
      { category_id: "mat", average_minor: 613333, normal_minor: 615000, fixed_minor: 0, saving_minor: 1801911, override_minor: null, actual_minor: 300000, over_pace: false },
    ],
    ...extra,
  };
}

function api(responses: Record<string, [number, unknown]> = {}, putStatus = 200) {
  const paths: string[] = [];
  const puts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/categories") return json(200, CATEGORIES);
      if (url.pathname === "/api/accounts") return json(200, { items: [] });
      if (url.pathname === "/api/guidelines") {
        if (init?.method === "PUT") {
          puts.push(JSON.parse(typeof init.body === "string" ? init.body : "null") as unknown);
          return json(putStatus, { mode: "saving" });
        }
        paths.push(url.pathname + url.search);
        const period = url.searchParams.get("period") ?? "";
        return json(...(responses[period] ?? [200, guidelines()]));
      }
      return json(404, { error: "not_found" });
    }),
  );
  return { paths, puts };
}

async function open(path = "/budget/riktlinjer") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
const form = () => screen.getByRole("form", { name: "Riktlinjer" });
const rows = () => within(screen.getByRole("list", { name: "Kategorier" })).getAllByRole("listitem");

describe("Riktlinjer och sparläge (KK-42)", () => {
  it("visar kvar att spendera fritt och per dag, och hur det räknades (KK-42-C)", async () => {
    const { paths } = api();
    await open();
    expect(paths[0]).toBe("/api/guidelines?period=current");
    const card = screen.getByRole("region", { name: "Kvar att spendera fritt" });
    expect(within(card).getAllByRole("definition").map((d) => d.textContent)).toEqual([formatSek(1700000), formatSek(106250)]);
    expect(card.textContent).toContain(`Förväntad inkomst ${formatSek(4000000)} − fasta kostnader ${formatSek(900000)} − sparmål ${formatSek(800000)} = ${formatSek(2300000)}`);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("visar snitt, normalt, fast del och sparläge per kategori, och Över takt som text (KK-42-A, KK-42-D)", async () => {
    api();
    await open();
    expect(rows().map((r) => r.querySelector(".tx-name")?.textContent)).toEqual(["Boende", "Fritid", "Mat"]);
    expect(rows()[0]?.textContent).toContain(`Snitt ${formatSek(900000)} · normalt ${formatSek(900000)} (varav fast ${formatSek(900000)}) · sparläge ${formatSek(900000)} · hittills ${formatSek(0)}`);
    expect(rows()[1]?.textContent).toContain("Över takt");
    expect(rows()[1]?.className).toContain("over");
    expect(rows()[2]?.textContent).not.toContain("Över takt");
  });

  it("utan sparläge visas inget om kvar att spendera och ingen sparlägesnivå", async () => {
    api({ current: [200, guidelines({ mode: "none" })] });
    await open();
    expect(screen.queryByRole("region", { name: "Kvar att spendera fritt" })).toBeNull();
    expect(rows()[2]?.textContent).not.toContain("sparläge");
    expect(screen.queryByLabelText("Sparmål per period (kr)")).toBeNull();
  });

  it("ett sparmål som inte går ihop står i text med vad som saknas (KK-42-C)", async () => {
    api({ current: [200, guidelines({ feasible: false, shortfall_minor: 900000, free_to_spend_minor: 0, remaining_free_minor: -100000 })] });
    await open();
    expect(screen.getByRole("alert").textContent).toContain(`Det saknas ${formatSek(900000)} per period`);
    expect(screen.getByRole("note").textContent).toContain(`${formatSek(100000)} mer än det fria utrymmet`);
  });

  it("säger till när ingen inkomst hittades", async () => {
    api({ current: [200, guidelines({ expected_income_minor: 0, free_to_spend_minor: 0, remaining_free_minor: 0 })] });
    await open();
    expect(screen.getByRole("note").textContent).toContain("Ingen lön eller föräldrapenning");
  });

  it("tål ett svar med trasiga rader: de hoppas över och orimliga tal blir noll", async () => {
    api({
      current: [200, guidelines({ expected_income_minor: "mycket", one_off_periods: ["2026-09", 5], categories: [{}, { category_id: 5 }, { category_id: "mat", average_minor: 1.5, normal_minor: 615000 }] })],
    });
    await open();
    expect(rows().map((r) => r.querySelector(".tx-name")?.textContent)).toEqual(["Mat"]);
    expect(rows()[0]?.textContent).toContain(`Snitt ${formatSek(0)} · normalt ${formatSek(615000)}`);
  });

  it("ett okänt läge i svaret räknas som ett fel", async () => {
    api({ current: [200, guidelines({ mode: "spara" })] });
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta riktlinjerna");
  });

  it("utan historik står det, och felet vid hämtning visas", async () => {
    api({ current: [200, guidelines({ categories: [] })] });
    await open();
    expect(screen.getByText("Det finns ingen historik att räkna riktlinjer på än.")).toBeTruthy();
    cleanup();
    api({ current: [500, { error: "unavailable" }] });
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta riktlinjerna");
  });

  it("sparar läge, sparmål, egna nivåer och engångsperioder, och hämtar om (KK-42-A)", async () => {
    const { puts, paths } = api();
    await open();
    fireEvent.change(screen.getByLabelText("Sparmål per period (kr)"), { target: { value: "9 000" } });
    fireEvent.change(screen.getByLabelText("Egen nivå för Mat (kr)"), { target: { value: "5000,50" } });
    fireEvent.change(screen.getByLabelText("Egen nivå för Fritid (kr)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /augusti 2026/u }));
    fireEvent.click(screen.getByRole("checkbox", { name: /september 2026/u }));
    await act(async () => {
      fireEvent.submit(form());
      await Promise.resolve();
    });
    await settle();
    expect(puts).toEqual([{ mode: "saving", saving_goal_minor: 900000, overrides: [{ category_id: "mat", amount_minor: 500050 }], one_off_periods: ["2026-08"] }]);
    expect(paths).toHaveLength(2);
  });

  it("byter läge till ingen budget och sparar sparmålet som noll när fältet är tomt", async () => {
    const { puts } = api();
    await open();
    fireEvent.change(screen.getByLabelText("Sparmål per period (kr)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: /Ingen budget/u }));
    expect(screen.queryByLabelText("Sparmål per period (kr)")).toBeNull();
    await act(async () => {
      fireEvent.submit(form());
      await Promise.resolve();
    });
    expect(puts[0]).toMatchObject({ mode: "none", saving_goal_minor: 0 });
  });

  it("avvisar ett belopp som inte är ett belopp, utan att spara", async () => {
    const { puts } = api();
    await open();
    fireEvent.change(screen.getByLabelText("Sparmål per period (kr)"), { target: { value: "mycket" } });
    await act(async () => {
      fireEvent.submit(form());
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("Skriv sparmålet i kronor");
    fireEvent.change(screen.getByLabelText("Sparmål per period (kr)"), { target: { value: "8000" } });
    fireEvent.change(screen.getByLabelText("Egen nivå för Mat (kr)"), { target: { value: "-5" } });
    await act(async () => {
      fireEvent.submit(form());
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("Skriv nivåerna i kronor");
    expect(puts).toEqual([]);
  });

  it("visar ett fel när det inte gick att spara", async () => {
    api({}, 503);
    await open();
    await act(async () => {
      fireEvent.submit(form());
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att spara riktlinjerna");
  });

  it("går att nå från Budget, och bläddrar mellan perioder", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      if (url.pathname === "/api/categories") return json(CATEGORIES);
      if (url.pathname === "/api/accounts") return json({ items: [] });
      return json({ period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" }, lines: [], groups: [], uncategorized_minor: 0, total_budget_minor: 0, total_actual_minor: 0, excluded_internal_minor: 0 });
    }));
    await open("/budget");
    const link = screen.getByRole("link", { name: "Riktlinjer och sparläge" });
    expect(link.getAttribute("href")).toBe("/budget/riktlinjer");
    expect(screen.getByRole("link", { name: "Budget" }).getAttribute("aria-current")).toBe("page");
  });

  it("Budget är markerad i menyn på riktlinjesidan, och föregående period hämtas", async () => {
    const { paths } = api({ "2026-10": [200, guidelines({ period: { key: "2026-10", start: "2026-10-01", end: "2026-10-31" } })] });
    await open();
    expect(screen.getByRole("link", { name: "Budget" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Föregående period" }));
    await settle();
    expect(paths.at(-1)).toBe("/api/guidelines?period=2026-10");
  });
});
