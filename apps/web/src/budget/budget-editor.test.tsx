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
    { id: "gammal", parent_id: null, name: "Gammal", kind: "expense", archived: true },
    { id: "inkomst-lon", parent_id: null, name: "Lön", kind: "income", archived: false },
  ],
};

type Line = { category_id: string; budget_minor: number };
type Group = { category_id: string; actual_minor: number };

/** Påhittade perioder (KK-13): budgetrader och utfall per huvudkategori per periodnyckel. */
function period(key: string, lines: Line[] = [], groups: Group[] = []) {
  return {
    period: { key, start: `${key}-01`, end: `${key}-28` },
    lines,
    groups: groups.map((g) => ({ ...g, budget_minor: null, remaining_minor: null, percent: null, over: false, subcategories: [] })),
    uncategorized_minor: 0,
    total_budget_minor: 0,
    total_actual_minor: 0,
    excluded_internal_minor: 0,
  };
}

const PERIODS: Record<string, unknown> = {
  current: period("2026-11", [{ category_id: "mat", budget_minor: 630000 }]),
  "2026-10": period("2026-10", [{ category_id: "boende", budget_minor: 990000 }, { category_id: "mat-livsmedel", budget_minor: 400000 }, { category_id: "gammal", budget_minor: 100 }], [
    { category_id: "mat", actual_minor: 300000 },
  ]),
  "2026-09": period("2026-09", [], [{ category_id: "mat", actual_minor: 600050 }]),
  "2026-08": period("2026-08", [], [{ category_id: "boende", actual_minor: 30000 }]),
};

function api(overrides: Record<string, [number, unknown]> = {}, putStatus = 200) {
  const puts: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/categories") return json(200, CATEGORIES);
      const key = /^\/api\/budgets\/(.+)$/u.exec(url.pathname)?.[1] ?? "";
      if (init?.method === "PUT") {
        puts.push({ path: url.pathname, body: JSON.parse(typeof init.body === "string" ? init.body : "null") as unknown });
        return json(putStatus, { period: key, lines: 1 });
      }
      const override = overrides[key];
      if (override) return json(...override);
      return key in PERIODS ? json(200, PERIODS[key]) : json(404, { error: "not_found" });
    }),
  );
  return puts;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function openEditor() {
  window.history.replaceState(null, "", "/budget");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^(Ändra|Sätt) budget$/u }));
  return screen.getByRole("form", { name: "Sätt budget" });
}

const field = (form: HTMLElement, label: string) => within(form).getByLabelText<HTMLInputElement>(label);
const labels = (form: HTMLElement) => within(form).getAllByRole("textbox").map((i) => i.closest("label")?.firstChild?.textContent);

async function click(form: HTMLElement, name: string) {
  fireEvent.click(within(form).getByRole("button", { name }));
  await settle();
}

describe("sätt budget per huvudkategori (#33, KK-20-A)", () => {
  it("visar bara huvudkategorierna som standard, ifyllda med periodens budget", async () => {
    api();
    const form = await openEditor();
    expect(labels(form)).toEqual(["Boende", "Mat"]);
    expect(field(form, "Mat").value).toBe("6300");
  });

  it("Fördela på underkategorier visar dem med kort namn, och varnar när de blir mer än huvudkategorin", async () => {
    api();
    const form = await openEditor();
    const button = within(form).getByRole("button", { name: "Fördela på underkategorier" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(labels(form)).toEqual(["Boende", "Mat", "Livsmedel", "Restaurang"]);
    fireEvent.change(field(form, "Livsmedel"), { target: { value: "5000" } });
    fireEvent.change(field(form, "Restaurang"), { target: { value: "2000" } });
    expect(within(form).getByText(/Underkategorierna är tillsammans/u).textContent).toBe(
      `Underkategorierna är tillsammans ${formatSek(700000)}, mer än ${formatSek(630000)}. Huvudkategorins belopp gäller.`,
    );
    fireEvent.click(within(form).getByRole("button", { name: "Dölj underkategorier" }));
    expect(labels(form)).toEqual(["Boende", "Mat"]);
  });

  it("sparar beloppen i öre, både huvud- och underkategorier, och hoppar över tomma fält och noll", async () => {
    const puts = api();
    const form = await openEditor();
    fireEvent.change(field(form, "Mat"), { target: { value: "6 300,50" } });
    fireEvent.change(field(form, "Boende"), { target: { value: "0" } });
    fireEvent.click(within(form).getByRole("button", { name: "Fördela på underkategorier" }));
    fireEvent.change(field(form, "Livsmedel"), { target: { value: "4000" } });
    await click(form, "Spara");
    expect(puts).toEqual([
      { path: "/api/budgets/2026-11", body: { lines: [{ category_id: "mat", amount_minor: 630050 }, { category_id: "mat-livsmedel", amount_minor: 400000 }], source: "manual" } },
    ]);
    expect(screen.queryByRole("form", { name: "Sätt budget" })).toBeNull();
  });

  it("kopierar förra periodens budget, fäller ut huvudkategorier med underkategoribudget och hoppar över arkiverade", async () => {
    const puts = api();
    const form = await openEditor();
    await click(form, "Kopiera oktober");
    expect(field(form, "Boende").value).toBe("9900");
    expect(field(form, "Livsmedel").value).toBe("4000");
    expect(field(form, "Mat").value).toBe("");
    await click(form, "Spara");
    expect(puts[0]?.body).toEqual({ lines: [{ category_id: "boende", amount_minor: 990000 }, { category_id: "mat-livsmedel", amount_minor: 400000 }], source: "copy_previous" });
  });

  it("föreslår snittet per huvudkategori de tre senaste perioderna, avrundat uppåt till tiotal kronor", async () => {
    const puts = api();
    const form = await openEditor();
    await click(form, "Föreslå från snitt");
    // Mat (3 000 + 6 000,50 + 0) / 3 = 3 000,17 → 3 010 kr. Boende 300 / 3 = 100 kr.
    expect(field(form, "Mat").value).toBe("3010");
    expect(field(form, "Boende").value).toBe("100");
    fireEvent.change(field(form, "Boende"), { target: { value: "200" } });
    await click(form, "Spara");
    expect(puts[0]?.body).toMatchObject({ source: "manual" });
  });

  it("säger till när det inte finns något att kopiera eller räkna snitt på, och när perioder inte går att hämta", async () => {
    api({ "2026-10": [200, period("2026-10")], "2026-09": [200, period("2026-09")], "2026-08": [200, period("2026-08")] });
    const form = await openEditor();
    await click(form, "Kopiera oktober");
    expect(within(form).getByRole("alert").textContent).toBe("Förra perioden har ingen budget att kopiera.");
    await click(form, "Föreslå från snitt");
    expect(within(form).getByRole("alert").textContent).toBe("Det finns inga utgifter de tre senaste perioderna att räkna snitt på.");
    cleanup();
    api({ "2026-10": [503, { error: "unavailable" }] });
    const again = await openEditor();
    await click(again, "Kopiera oktober");
    expect(within(again).getByRole("alert").textContent).toBe("Det gick inte att hämta förra periodens budget.");
    await click(again, "Föreslå från snitt");
    expect(within(again).getByRole("alert").textContent).toBe("Det gick inte att hämta de tidigare perioderna.");
  });

  it("sparar inte text som inte är ett belopp, och säger till när servern inte sparar", async () => {
    const puts = api({}, 503);
    const form = await openEditor();
    fireEvent.change(field(form, "Mat"), { target: { value: "mycket" } });
    await click(form, "Spara");
    expect(within(form).getByRole("alert").textContent).toBe("Skriv beloppen i kronor, till exempel 6 300.");
    expect(puts).toEqual([]);
    fireEvent.change(field(form, "Mat"), { target: { value: "-5" } });
    await click(form, "Spara");
    expect(puts).toEqual([]);
    fireEvent.change(field(form, "Mat"), { target: { value: "5000" } });
    await click(form, "Spara");
    expect(within(form).getByRole("alert").textContent).toBe("Det gick inte att spara budgeten. Försök igen.");
  });

  it("Avbryt stänger utan att spara, och utan budget heter knappen Sätt budget", async () => {
    const puts = api({ current: [200, period("2026-11")] });
    window.history.replaceState(null, "", "/budget");
    await act(async () => {
      render(<App />);
      await Promise.resolve();
    });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Sätt budget" }));
    await click(screen.getByRole("form", { name: "Sätt budget" }), "Avbryt");
    expect(screen.queryByRole("form", { name: "Sätt budget" })).toBeNull();
    expect(puts).toEqual([]);
  });
});
