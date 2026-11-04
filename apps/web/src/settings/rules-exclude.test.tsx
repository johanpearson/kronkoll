// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = { items: [{ id: "hushall", parent_id: null, name: "Hushåll", kind: "expense", archived: false }] };

/** Påhittade regler (KK-13): en kategoriregel och en Räkna inte-regel. */
const RULES = {
  items: [
    { id: "r-ikea", match: "counterparty_prefix", pattern: "IKEA", category_id: "hushall", source: "learned", action: "categorize", hits: 2, category_archived: false },
    { id: "r-mobler", match: "counterparty_prefix", pattern: "PAHITTADE MOBLER", category_id: null, source: "learned", action: "exclude", hits: 3, category_archived: false },
  ],
};

type Call = { method: string; path: string; body: unknown };

function api(answers: { preview?: [number, unknown]; save?: [number, unknown] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ method, path: url.pathname, body });
      const json = (status: number, payload: unknown) => Promise.resolve(new Response(JSON.stringify(payload), { status }));
      if (url.pathname === "/api/categories") return json(200, CATEGORIES);
      if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (body?.["preview"] === true) return json(...(answers.preview ?? [200, { matches: 3 }]));
      if (method !== "GET") return json(...(answers.save ?? [201, { rule: { id: "r-ny", action: "exclude" }, matches: 3 }]));
      return json(200, RULES);
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

const row = (pattern: string) => within(screen.getByRole("list", { name: "Regler" })).getByText(pattern).closest("li") as HTMLElement;
const click = async (name: string, inside: HTMLElement = document.body) => {
  fireEvent.click(within(inside).getByRole("button", { name }));
  await settle();
};
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET").map(({ method, path, body }) => ({ method, path, body }));

async function newExcludeRule(pattern: string) {
  await click("Ny regel");
  fireEvent.change(screen.getByLabelText("Allt som börjar med"), { target: { value: pattern } });
  fireEvent.change(screen.getByLabelText("Får kategorin"), { target: { value: "exclude" } });
  await click("Spara");
}

describe("regler med åtgärden Räkna inte (KK-39-C)", () => {
  it("visas i listan med Räknas inte i stället för kategori, och går att söka fram", async () => {
    api();
    await open();
    expect(row("PAHITTADE MOBLER").querySelector(".tx-notes")?.textContent).toBe("→ Räknas inte · Egen · 3 träffar");
    fireEvent.change(screen.getByRole("searchbox", { name: "Sök regel" }), { target: { value: "räknas" } });
    expect(within(screen.getByRole("list", { name: "Regler" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("visar hur många den träffar innan den sparas, och sparar först när du bekräftar", async () => {
    const calls = api();
    await open();
    await newExcludeRule("påhittade möbler");
    expect(writes(calls)).toEqual([{ method: "POST", path: "/api/rules", body: { pattern: "påhittade möbler", action: "exclude", preview: true } }]);
    expect(screen.getByText("Regeln träffar 3 transaktioner. De räknas inte i budget och översikt. Det du själv har valt ändras inte.")).toBeDefined();
    await click("Spara regeln");
    expect(writes(calls).at(-1)).toEqual({ method: "POST", path: "/api/rules", body: { pattern: "påhittade möbler", action: "exclude" } });
    expect(screen.getByRole("status").textContent).toBe("Regeln är sparad. 3 transaktioner räknas inte längre.");
  });

  it("Avbryt efter förhandsvisningen sparar ingenting", async () => {
    const calls = api();
    await open();
    await newExcludeRule("påhittade möbler");
    await click("Avbryt");
    expect(writes(calls)).toHaveLength(1);
    expect(screen.queryByText(/Regeln träffar/u)).toBeNull();
  });

  it("säger till när förhandsvisningen inte går att hämta", async () => {
    api({ preview: [503, { error: "unavailable" }] });
    await open();
    await newExcludeRule("påhittade möbler");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att räkna träffarna. Försök igen.");
  });

  it("säger till när regeln inte går att spara, och låter dig försöka igen", async () => {
    api({ save: [503, { error: "unavailable" }] });
    await open();
    await newExcludeRule("påhittade möbler");
    await click("Spara regeln");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara regeln. Försök igen.");
    expect(screen.getByRole("button", { name: "Spara regeln" })).toBeDefined();
  });

  it("en Räkna inte-regel har bara namnet att ändra, ingen förhandsvisning av kategorier, och säger vad borttagning gör", async () => {
    const calls = api({ save: [200, { rule: { id: "r-mobler", action: "exclude" }, matches: 1 }] });
    await open();
    await click("Ändra regeln PAHITTADE MOBLER");
    expect(within(row("PAHITTADE MOBLER")).queryByRole("button", { name: "Visa träffar" })).toBeNull();
    await click("Ändra namn", row("PAHITTADE MOBLER"));
    expect(within(row("PAHITTADE MOBLER")).queryByLabelText("Får kategorin")).toBeNull();
    fireEvent.change(within(row("PAHITTADE MOBLER")).getByLabelText("Allt som börjar med"), { target: { value: "påhittade möbler ab" } });
    await click("Spara", row("PAHITTADE MOBLER"));
    expect(writes(calls)).toEqual([{ method: "PATCH", path: "/api/rules/r-mobler", body: { pattern: "påhittade möbler ab" } }]);
    expect(screen.getByRole("status").textContent).toBe("Regeln är sparad. 1 transaktioner räknas inte längre.");

    await click("Ändra regeln PAHITTADE MOBLER");
    await click("Ta bort", row("PAHITTADE MOBLER"));
    expect(row("PAHITTADE MOBLER").textContent).toContain("Ta bort regeln? Dess träffar räknas igen, utom det du själv har valt.");
  });
});
