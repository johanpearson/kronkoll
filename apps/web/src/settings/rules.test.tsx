// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    { id: "hushall", parent_id: null, name: "Hushåll", kind: "expense", archived: false },
    { id: "noje", parent_id: null, name: "Nöje", kind: "expense", archived: true },
  ],
};

const RULES = {
  items: [
    { id: "r-ica", match: "counterparty_prefix", pattern: "ICA", category_id: "mat-livsmedel", source: "template", hits: 14, category_archived: false, position: null },
    { id: "r-ikea", match: "counterparty_prefix", pattern: "IKEA", category_id: "hushall", source: "learned", hits: 1, category_archived: false, position: 1 },
    { id: "r-bio", match: "counterparty_prefix", pattern: "SF BIO", category_id: "noje", source: "learned", hits: 0, category_archived: true, position: 0 },
  ],
};

type Call = { method: string; path: string; body: unknown; csrf: string | null };

function api(answers: { save?: [number, unknown]; remove?: number; order?: number; rules?: [number, unknown] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null, csrf: new Headers(init?.headers).get("x-kronkoll") });
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/categories") return json(200, CATEGORIES);
      if (method === "DELETE") return Promise.resolve(new Response(null, { status: answers.remove ?? 204 }));
      if (url.pathname === "/api/rules/order") return json(answers.order ?? 200, { updated: 0 });
      if (method !== "GET") return json(...(answers.save ?? [201, { rule: { id: "r-ny" }, retroactive_candidates: 0, protected_manual: 0 }]));
      return json(...(answers.rules ?? [200, RULES]));
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function open() {
  window.history.replaceState(null, "", "/installningar/regler");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const rows = () => within(screen.getByRole("list", { name: "Regler" })).getAllByRole("listitem");
const label = (li: HTMLElement) => li.querySelector(".ui-row-label")?.textContent;
const detail = (li: HTMLElement) => li.querySelector(".ui-row-detail")?.textContent;
const sheet = () => within(screen.getByRole("dialog"));
/** Öppnar arket för regeln med mönstret. */
const openRule = async (pattern: string) => {
  const li = rows().find((r) => label(r)?.includes(` ${pattern} →`));
  if (!li) throw new Error(`Ingen regel ${pattern}`);
  fireEvent.click(within(li).getByRole("button"));
  await settle();
};
const changes = (calls: Call[]) => calls.filter((c) => c.method !== "GET").map(({ method, path, body, csrf }) => ({ method, path, body, csrf }));
const click = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  await settle();
};
/** Knappen inne i arket eller dialogen som är öppen. */
const press = async (name: string) => {
  fireEvent.click(sheet().getByRole("button", { name }));
  await settle();
};

async function fillNewRule(pattern: string, categoryId: string) {
  await click("Ny regel");
  fireEvent.change(sheet().getByLabelText("Text"), { target: { value: pattern } });
  fireEvent.change(sheet().getByLabelText("Får kategorin"), { target: { value: categoryId } });
  await press("Spara");
}

describe("regler i Inställningar (#251, KK-18-B, KK-18-C, KK-58-C)", () => {
  it("visar villkoret i klartext med källa och träffar, och markerar en arkiverad kategori med text", async () => {
    api();
    await open();
    expect(rows().map(label)).toEqual(["Börjar med SF BIO → Nöje", "Börjar med IKEA → Hushåll", "Börjar med ICA → Mat › Livsmedel"]);
    expect(rows().map(detail)).toEqual(["Egen · 0 träffar Kategorin är arkiverad", "Egen · 1 träff", "Mall · 14 träffar"]);
  });

  it("ordnar de egna reglerna efter plats, den som vinner först, och mallreglerna efter dem", async () => {
    api({ rules: [200, { items: [RULES.items[0], { ...RULES.items[1], position: 0 }, { ...RULES.items[2], position: 1 }] }] });
    await open();
    expect(rows().map((r) => label(r)?.split(" → ")[0])).toEqual(["Börjar med IKEA", "Börjar med SF BIO", "Börjar med ICA"]);
  });

  it("filtrerar på namn och kategori", async () => {
    api();
    await open();
    fireEvent.change(screen.getByRole("searchbox", { name: "Sök regel" }), { target: { value: "ik" } });
    expect(rows().map(label)).toEqual(["Börjar med IKEA → Hushåll"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Sök regel" }), { target: { value: "livsmedel" } });
    expect(rows().map(label)).toEqual(["Börjar med ICA → Mat › Livsmedel"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Sök regel" }), { target: { value: "finns inte" } });
    expect(screen.getByText("Inga regler matchar.")).toBeTruthy();
  });

  it("lägger till en regel i ett ark och säger hur många tidigare transaktioner som fick kategorin (KK-58-A)", async () => {
    const calls = api({ save: [201, { rule: { id: "r-ny" }, applied: 7, protected_manual: 1 }] });
    await open();
    await fillNewRule("skanetrafiken", "mat");
    expect(changes(calls)).toEqual([{ method: "POST", path: "/api/rules", body: { pattern: "skanetrafiken", match: "prefix", category_id: "mat" }, csrf: "1" }]);
    expect(screen.getByRole("status").textContent).toBe("Regeln är sparad. 7 tidigare transaktioner fick kategorin.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.filter((c) => c.path === "/api/rules" && c.method === "GET")).toHaveLength(2);
  });

  it("utan träffar bakåt säger den att regeln gäller nya transaktioner", async () => {
    api();
    await open();
    await fillNewRule("ikea", "hushall");
    expect(screen.getByRole("status").textContent).toBe("Regeln är sparad och gäller nya transaktioner.");
  });

  it("en regel som innehåller en text skickar med slaget, och Innehåller visas i listan (KK-47-B)", async () => {
    const calls = api({
      rules: [200, { items: [...RULES.items, { id: "r-amazon", match: "description_contains", pattern: "AMAZON", category_id: "hushall", source: "learned", hits: 4, category_archived: false, position: 2 }] }],
    });
    await open();
    expect(rows().map(label)).toContain("Innehåller AMAZON → Hushåll");
    await click("Ny regel");
    fireEvent.click(sheet().getByRole("radio", { name: "Innehåller" }));
    expect(sheet().getByLabelText<HTMLInputElement>("Text").placeholder).toBe("amazon");
    expect(sheet().getByText("Versaler och gemener spelar ingen roll.")).toBeTruthy();
    fireEvent.change(sheet().getByLabelText("Text"), { target: { value: "Amazon" } });
    fireEvent.change(sheet().getByLabelText("Får kategorin"), { target: { value: "hushall" } });
    await press("Spara");
    expect(changes(calls)).toEqual([{ method: "POST", path: "/api/rules", body: { pattern: "Amazon", match: "contains", category_id: "hushall" }, csrf: "1" }]);
  });

  it("en befintlig innehåller-regel öppnas som Innehåller och behåller slaget när den ändras", async () => {
    const calls = api({
      rules: [200, { items: [{ id: "r-amazon", match: "description_contains", pattern: "AMAZON", category_id: "hushall", source: "learned", hits: 4, category_archived: false, position: 0 }] }],
    });
    await open();
    await openRule("AMAZON");
    await press("Ändra namn eller kategori");
    expect(sheet().getByRole("radio", { name: "Innehåller" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sheet().getByRole("radio", { name: "Börjar med" }));
    await press("Spara");
    expect(changes(calls)).toEqual([{ method: "PATCH", path: "/api/rules/r-amazon", body: { pattern: "AMAZON", match: "prefix", category_id: "hushall" }, csrf: "1" }]);
  });

  it("ändrar namn och kategori på en regel", async () => {
    const calls = api({ save: [200, { rule: { id: "r-ica" }, applied: 0 }] });
    await open();
    await openRule("ICA");
    await press("Ändra namn eller kategori");
    expect(sheet().getByLabelText<HTMLInputElement>("Text").value).toBe("ICA");
    fireEvent.change(sheet().getByLabelText("Får kategorin"), { target: { value: "mat" } });
    await press("Spara");
    expect(changes(calls)).toEqual([{ method: "PATCH", path: "/api/rules/r-ica", body: { pattern: "ICA", match: "prefix", category_id: "mat" }, csrf: "1" }]);
  });

  it("tar bort efter en fråga i en dialog, och Stäng och Avbryt ändrar ingenting", async () => {
    const calls = api();
    await open();
    await openRule("IKEA");
    await press("Stäng");
    expect(screen.queryByRole("dialog")).toBeNull();
    await openRule("IKEA");
    await press("Ta bort");
    expect(screen.getByRole("dialog", { name: "Ta bort regeln IKEA?" })).toBeTruthy();
    expect(sheet().getByText("Transaktioner som redan har fått kategorin behåller den.")).toBeTruthy();
    await press("Avbryt");
    expect(changes(calls)).toEqual([]);
    await openRule("IKEA");
    await press("Ta bort");
    await press("Ta bort");
    expect(changes(calls)).toEqual([{ method: "DELETE", path: "/api/rules/r-ikea", body: null, csrf: "1" }]);
    expect(screen.getByRole("status").textContent).toBe("Regeln är borttagen.");
  });

  it("säger vilken plats en egen regel har, och erbjuder bara de flyttar som går", async () => {
    api();
    await open();
    await openRule("SF BIO");
    expect(sheet().getByRole("status").textContent).toBe("Plats 1 av 2. Regeln som står först vinner när flera träffar.");
    expect(sheet().queryByRole("button", { name: "Flytta upp" })).toBeNull();
    expect(sheet().getByRole("button", { name: "Flytta ner" })).toBeTruthy();
    await press("Stäng");
    await openRule("IKEA");
    expect(sheet().getByRole("button", { name: "Flytta upp" })).toBeTruthy();
    expect(sheet().queryByRole("button", { name: "Flytta ner" })).toBeNull();
    await press("Stäng");
    // En mallregel har ingen plats att flytta.
    await openRule("ICA");
    expect(sheet().queryByRole("status")).toBeNull();
    expect(sheet().queryByRole("button", { name: "Flytta upp" })).toBeNull();
    expect(sheet().queryByRole("button", { name: "Flytta ner" })).toBeNull();
  });

  it("flyttar en regel genom att skicka de egna reglernas ordning, och lämnar arket öppet", async () => {
    const calls = api();
    await open();
    await openRule("IKEA");
    await press("Flytta upp");
    expect(changes(calls)).toEqual([{ method: "PUT", path: "/api/rules/order", body: { order: ["r-ikea", "r-bio"] }, csrf: "1" }]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(calls.filter((c) => c.path === "/api/rules" && c.method === "GET")).toHaveLength(2);
    await press("Stäng");
    await openRule("SF BIO");
    await press("Flytta ner");
    expect(changes(calls).at(-1)?.body).toEqual({ order: ["r-ikea", "r-bio"] });
  });

  it("säger till i arket när en regel inte går att flytta", async () => {
    api({ order: 503 });
    await open();
    await openRule("IKEA");
    await press("Flytta upp");
    expect(sheet().getByRole("alert").textContent).toBe("Det gick inte att flytta regeln. Försök igen.");
    expect(sheet().getByRole("button", { name: "Flytta upp" })).toBeTruthy();
  });

  it.each([
    [[400, { error: "invalid_request" }], "Skriv en text, till exempel IKEA."],
    [[400, { error: "unknown_category" }], "Välj en kategori som finns."],
    [[503, { error: "unavailable" }], "Det gick inte att spara regeln. Försök igen."],
  ] as [[number, unknown], string][])("visar varför en regel inte sparas: %j", async (save, message) => {
    api({ save });
    await open();
    await fillNewRule("x", "mat");
    expect(sheet().getByRole("alert").textContent).toBe(message);
  });

  it("säger till när borttagning misslyckas, och när reglerna inte går att hämta", async () => {
    api({ remove: 503 });
    await open();
    await openRule("IKEA");
    await press("Ta bort");
    await press("Ta bort");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att ta bort regeln. Försök igen.");
    cleanup();
    api({ rules: [503, {}] });
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta reglerna");
  });
});
