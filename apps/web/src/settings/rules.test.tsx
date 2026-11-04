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
    { id: "r-ica", match: "counterparty_prefix", pattern: "ICA", category_id: "mat-livsmedel", source: "template", hits: 14, category_archived: false },
    { id: "r-ikea", match: "counterparty_prefix", pattern: "IKEA", category_id: "hushall", source: "learned", hits: 1, category_archived: false },
    { id: "r-bio", match: "counterparty_prefix", pattern: "SF BIO", category_id: "noje", source: "learned", hits: 0, category_archived: true },
  ],
};

type Call = { method: string; path: string; body: unknown; csrf: string | null };

function api(answers: { save?: [number, unknown]; apply?: [number, unknown]; remove?: number; rules?: [number, unknown] } = {}) {
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
      if (url.pathname.endsWith("/apply")) return json(...(answers.apply ?? [200, { updated: 12, skipped_manual: 1 }]));
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
const changes = (calls: Call[]) => calls.filter((c) => c.method !== "GET").map(({ method, path, body, csrf }) => ({ method, path, body, csrf }));
const click = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  await settle();
};

async function fillNewRule(pattern: string, categoryId: string) {
  await click("Ny regel");
  fireEvent.change(screen.getByLabelText("Allt som börjar med"), { target: { value: pattern } });
  fireEvent.change(screen.getByLabelText("Får kategorin"), { target: { value: categoryId } });
  await click("Spara");
}

describe("regler i Inställningar (#34, KK-18-B, KK-18-C)", () => {
  it("visar varje regel med kategori, källa och träffar, och markerar en arkiverad kategori med text", async () => {
    api();
    await open();
    expect(rows().map((r) => r.querySelector(".tx-notes")?.textContent)).toEqual([
      "→ Mat › Livsmedel · Mall · 14 träffar",
      "→ Hushåll · Egen · 1 träff",
      "→ Nöje · Egen · 0 träffar",
    ]);
    expect(rows()[2]?.textContent).toContain("Kategorin är arkiverad");
  });

  it("filtrerar på namn och kategori", async () => {
    api();
    await open();
    fireEvent.change(screen.getByRole("searchbox", { name: "Sök regel" }), { target: { value: "ik" } });
    expect(rows().map((r) => r.querySelector(".tx-name")?.textContent)).toEqual(["IKEA"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Sök regel" }), { target: { value: "livsmedel" } });
    expect(rows().map((r) => r.querySelector(".tx-name")?.textContent)).toEqual(["ICA"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Sök regel" }), { target: { value: "finns inte" } });
    expect(screen.getByText("Inga regler matchar.")).toBeTruthy();
  });

  it("lägger till en regel, frågar om tidigare transaktioner och applicerar på ja", async () => {
    const calls = api({ save: [201, { rule: { id: "r-ny" }, retroactive_candidates: 12, protected_manual: 1 }] });
    await open();
    await fillNewRule("skanetrafiken", "mat");
    expect(screen.getByText("Regeln matchar 12 tidigare transaktioner. 1 manuellt valda ändras inte.")).toBeTruthy();
    await click("Applicera på dem");
    expect(changes(calls)).toEqual([
      { method: "POST", path: "/api/rules", body: { pattern: "skanetrafiken", category_id: "mat" }, csrf: "1" },
      { method: "POST", path: "/api/rules/r-ny/apply", body: {}, csrf: "1" },
    ]);
    expect(screen.getByRole("status").textContent).toBe("12 transaktioner fick den nya kategorin.");
  });

  it("\"Inte nu\" sparar regeln utan att ändra tidigare, och utan träffar bakåt frågar den inte", async () => {
    const calls = api({ save: [201, { rule: { id: "r-ny" }, retroactive_candidates: 3, protected_manual: 0 }] });
    await open();
    await fillNewRule("ikea", "hushall");
    await click("Inte nu");
    expect(changes(calls).filter((c) => c.path.endsWith("/apply"))).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("Regeln är sparad och gäller nya transaktioner.");
    cleanup();
    api();
    await open();
    await fillNewRule("ikea", "hushall");
    expect(screen.getByRole("status").textContent).toBe("Regeln är sparad och gäller nya transaktioner.");
  });

  it("ändrar namn och kategori på en regel", async () => {
    const calls = api({ save: [200, { rule: { id: "r-ica" }, retroactive_candidates: 0, protected_manual: 0 }] });
    await open();
    await click("Ändra regeln ICA");
    await click("Ändra namn eller kategori");
    expect(screen.getByLabelText<HTMLInputElement>("Allt som börjar med").value).toBe("ICA");
    fireEvent.change(screen.getByLabelText("Får kategorin"), { target: { value: "mat" } });
    await click("Spara");
    expect(changes(calls)).toEqual([{ method: "PATCH", path: "/api/rules/r-ica", body: { pattern: "ICA", category_id: "mat" }, csrf: "1" }]);
  });

  it("tar bort efter en fråga, och Stäng och Avbryt ändrar ingenting", async () => {
    const calls = api();
    await open();
    await click("Ändra regeln IKEA");
    await click("Stäng");
    await click("Ändra regeln IKEA");
    await click("Ta bort");
    expect(screen.getByText("Ta bort regeln? Transaktioner som redan har fått kategorin behåller den.")).toBeTruthy();
    await click("Avbryt");
    expect(changes(calls)).toEqual([]);
    await click("Ändra regeln IKEA");
    await click("Ta bort");
    fireEvent.click(within(rows()[1] as HTMLElement).getAllByRole("button", { name: "Ta bort" })[0] as HTMLElement);
    await settle();
    expect(changes(calls)).toEqual([{ method: "DELETE", path: "/api/rules/r-ikea", body: null, csrf: "1" }]);
    expect(screen.getByRole("status").textContent).toBe("Regeln är borttagen.");
  });

  it.each([
    [[400, { error: "invalid_request" }], "Skriv början av ett namn, till exempel IKEA."],
    [[400, { error: "unknown_category" }], "Välj en kategori som finns."],
    [[503, { error: "unavailable" }], "Det gick inte att spara regeln. Försök igen."],
  ] as [[number, unknown], string][])("visar varför en regel inte sparas: %j", async (save, message) => {
    api({ save });
    await open();
    await fillNewRule("x", "mat");
    expect(screen.getByRole("alert").textContent).toBe(message);
  });

  it("säger till när applicering eller borttagning misslyckas, och när reglerna inte går att hämta", async () => {
    api({ save: [201, { rule: { id: "r-ny" }, retroactive_candidates: 2, protected_manual: 0 }], apply: [503, {}], remove: 503 });
    await open();
    await fillNewRule("ikea", "hushall");
    await click("Applicera på dem");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att applicera regeln. Försök igen.");
    await click("Ändra regeln IKEA");
    await click("Ta bort");
    fireEvent.click(within(rows()[1] as HTMLElement).getAllByRole("button", { name: "Ta bort" })[0] as HTMLElement);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att ta bort regeln. Försök igen.");
    cleanup();
    api({ rules: [503, {}] });
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta reglerna");
  });
});
