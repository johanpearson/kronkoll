// @vitest-environment jsdom
// Regelformuläret med träffar medan man skriver och valet att skriva över manuella (#251, KK-58-B).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { PREVIEW_DELAY_MS } from "./RuleForm.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = { items: [{ id: "hushall", parent_id: null, name: "Hushåll", kind: "expense", archived: false }] };
const RULES = { items: [{ id: "r-ikea", match: "counterparty_prefix", pattern: "IKEA", category_id: "hushall", source: "learned", hits: 2, category_archived: false, position: 0 }] };

/** Påhittade träffar (KK-13) i API:ts form. */
function matches(manual = 1) {
  return {
    total: 4,
    change: 2,
    unchanged: 1,
    manual,
    items: [
      { id: "k1", transaction_date: "2026-11-02", name: "IKEA KARLSTAD, KARLSTAD", amount_minor: -49900, category_id: null, effect: "change" },
      { id: "k2", transaction_date: "2026-10-20", name: "", amount_minor: -12000, category_id: "hushall", effect: "unchanged" },
      { id: "k3", transaction_date: "2026-10-01", name: "IKEA BARKARBY, JARFALLA", amount_minor: -30000, category_id: "fritid", effect: "manual" },
      { id: "k4", transaction_date: "2026-09-01", name: "IKEA SODERTALJE", amount_minor: -1000, category_id: null, effect: "change" },
    ],
  };
}

type Call = { method: string; path: string; body: Record<string, unknown> | null };

function api(answers: { preview?: (body: Record<string, unknown>) => Promise<Response> | [number, unknown] } = {}) {
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
      if (method !== "GET" && body?.["preview"] === true) {
        const answer = answers.preview?.(body) ?? [200, { applied: 3, protected_manual: 1, overridden_manual: 1, matches: matches() }];
        return Array.isArray(answer) ? json(...answer) : answer;
      }
      if (method !== "GET") return json(201, { rule: { id: "r-ny" }, applied: 3, retroactive_candidates: 0, protected_manual: 0 });
      return json(200, RULES);
    }),
  );
  return calls;
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
/** Låter tiden gå så att förhandsvisningen hinner fråga och svara. */
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function open() {
  window.history.replaceState(null, "", "/installningar/regler");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const sheet = () => within(screen.getByRole("dialog"));
const previews = (calls: Call[]) => calls.filter((c) => c.body?.["preview"] === true);

async function newRule(pattern: string) {
  fireEvent.click(screen.getByRole("button", { name: "Ny regel" }));
  await settle();
  fireEvent.change(sheet().getByLabelText("Text"), { target: { value: pattern } });
  fireEvent.change(sheet().getByLabelText("Får kategorin"), { target: { value: "hushall" } });
}

describe("regelformuläret visar träffarna medan man skriver (KK-58-B)", () => {
  it("frågar först en stund efter senaste ändringen, och visar antal och några exempel", async () => {
    const calls = api();
    await open();
    await newRule("ikea");
    await wait(PREVIEW_DELAY_MS - 1);
    expect(previews(calls)).toEqual([]);
    await wait(1);
    expect(previews(calls)).toEqual([{ method: "POST", path: "/api/rules", body: { pattern: "ikea", match: "prefix", category_id: "hushall", preview: true, override_manual: false } }]);
    expect(sheet().getByText("Regeln träffar 4 transaktioner: 2 får kategorin, 1 har redan kategorin, 1 är manuellt valda.")).toBeTruthy();
    const examples = within(sheet().getByRole("list", { name: "Exempel på träffar" })).getAllByRole("listitem");
    // Antalen gäller alla träffar, men bara de tre första visas som exempel.
    expect(examples).toHaveLength(3);
    expect(examples.map((li) => li.querySelector(".ui-row-label")?.textContent)).toEqual(["IKEA KARLSTAD, KARLSTAD", "Okänd motpart", "IKEA BARKARBY, JARFALLA"]);
    expect(examples.map((li) => li.querySelector(".ui-row-detail")?.textContent)).toEqual(["2 nov. 2026 · Får kategorin", "20 okt. 2026 · Har redan kategorin", "1 okt. 2026 · Manuellt vald, ändras inte"]);
  });

  it("frågar en gång för det som skrivs i ett svep, och det sista svaret gäller även om ett äldre kommer efter", async () => {
    let late: (response: Response) => void = () => undefined;
    let first = true;
    const calls = api({
      preview: () => {
        if (!first) return [200, { matches: { ...matches(0), total: 1, change: 1, unchanged: 0, items: [] } }];
        first = false;
        return new Promise<Response>((resolve) => { late = resolve; });
      },
    });
    await open();
    await newRule("i");
    await wait(PREVIEW_DELAY_MS);
    fireEvent.change(sheet().getByLabelText("Text"), { target: { value: "ik" } });
    fireEvent.change(sheet().getByLabelText("Text"), { target: { value: "ikea" } });
    await wait(PREVIEW_DELAY_MS);
    expect(previews(calls).map((c) => c.body?.["pattern"])).toEqual(["i", "ikea"]);
    expect(sheet().getByText("Regeln träffar 1 transaktioner: 1 får kategorin.")).toBeTruthy();
    // Svaret på "i" kommer sist men gäller inte längre.
    late(new Response(JSON.stringify({ matches: { ...matches(0), total: 9 } }), { status: 200 }));
    await settle();
    expect(sheet().queryByText(/träffar 9 transaktioner/u)).toBeNull();
    expect(sheet().getByText(/träffar 1 transaktioner/u)).toBeTruthy();
  });

  it("säger att regeln inte träffar något, och visar inga exempel då", async () => {
    api({ preview: () => [200, { matches: { total: 0, change: 0, unchanged: 0, manual: 0, items: [] } }] });
    await open();
    await newRule("finns inte");
    await wait(PREVIEW_DELAY_MS);
    expect(sheet().getByText("Regeln träffar inga transaktioner än.")).toBeTruthy();
    expect(sheet().queryByRole("list", { name: "Exempel på träffar" })).toBeNull();
  });

  it("frågar inte utan text eller kategori, och inte för Räkna inte, som har sin egen bekräftelse", async () => {
    const calls = api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ny regel" }));
    await settle();
    fireEvent.change(sheet().getByLabelText("Text"), { target: { value: "ikea" } });
    await wait(PREVIEW_DELAY_MS * 2);
    fireEvent.change(sheet().getByLabelText("Får kategorin"), { target: { value: "exclude" } });
    await wait(PREVIEW_DELAY_MS * 2);
    expect(previews(calls)).toEqual([]);
    expect(sheet().queryByRole("list", { name: "Exempel på träffar" })).toBeNull();
  });

  it("en ändrad regel förhandsvisas som en ändring av regeln, med det nya slaget", async () => {
    const calls = api();
    await open();
    fireEvent.click(within(within(screen.getByRole("list", { name: "Regler" })).getAllByRole("listitem")[0] as HTMLElement).getByRole("button"));
    await settle();
    fireEvent.click(sheet().getByRole("button", { name: "Ändra namn eller kategori" }));
    await wait(PREVIEW_DELAY_MS);
    expect(previews(calls)[0]).toEqual({ method: "PATCH", path: "/api/rules/r-ikea", body: { pattern: "IKEA", match: "prefix", category_id: "hushall", preview: true, override_manual: false } });
    fireEvent.click(sheet().getByRole("radio", { name: "Innehåller" }));
    await wait(PREVIEW_DELAY_MS);
    expect(previews(calls).at(-1)?.body?.["match"]).toBe("contains");
  });

  it("säger till när träffarna inte går att räkna, men låter dig spara ändå", async () => {
    const calls = api({ preview: () => [503, { error: "unavailable" }] });
    await open();
    await newRule("ikea");
    await wait(PREVIEW_DELAY_MS);
    expect(sheet().getByText("Det gick inte att räkna träffarna. Du kan ändå spara regeln.")).toBeTruthy();
    fireEvent.click(sheet().getByRole("button", { name: "Spara" }));
    await settle();
    expect(calls.filter((c) => c.method === "POST" && c.body?.["preview"] === undefined)).toHaveLength(1);
  });
});

describe("Skriv över även manuellt kategoriserade (KK-58-B)", () => {
  it("finns bara när regeln träffar manuellt valda, med antalet, och är av från början", async () => {
    api({ preview: () => [200, { matches: matches(0) }] });
    await open();
    await newRule("ikea");
    await wait(PREVIEW_DELAY_MS);
    expect(sheet().queryByRole("switch")).toBeNull();
    cleanup();
    api();
    await open();
    await newRule("ikea");
    await wait(PREVIEW_DELAY_MS);
    const toggle = sheet().getByRole("switch", { name: "Skriv över även manuellt kategoriserade" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(sheet().getByText("1 manuellt valda ändras inte. Det du själv har valt rörs annars aldrig.")).toBeTruthy();
  });

  it("slås det på räknas förhandsvisningen om med valet, och regeln sparas med override_manual", async () => {
    const calls = api();
    await open();
    await newRule("ikea");
    await wait(PREVIEW_DELAY_MS);
    fireEvent.click(sheet().getByRole("switch", { name: "Skriv över även manuellt kategoriserade" }));
    expect(sheet().getByText("1 manuellt valda får kategorin.")).toBeTruthy();
    await wait(PREVIEW_DELAY_MS);
    expect(previews(calls).at(-1)?.body?.["override_manual"]).toBe(true);
    fireEvent.click(sheet().getByRole("button", { name: "Spara" }));
    await settle();
    expect(calls.filter((c) => c.method === "POST" && c.body?.["preview"] === undefined).map((c) => c.body)).toEqual([
      { pattern: "ikea", match: "prefix", category_id: "hushall", override_manual: true },
    ]);
  });

  it("utan valet skickas inget override_manual, även om det slogs på och träffarna sedan blev inga manuella", async () => {
    let manual = 1;
    const calls = api({ preview: () => [200, { matches: matches(manual) }] });
    await open();
    await newRule("ikea");
    await wait(PREVIEW_DELAY_MS);
    fireEvent.click(sheet().getByRole("switch", { name: "Skriv över även manuellt kategoriserade" }));
    manual = 0;
    await wait(PREVIEW_DELAY_MS);
    expect(sheet().queryByRole("switch")).toBeNull();
    fireEvent.click(sheet().getByRole("button", { name: "Spara" }));
    await settle();
    expect(calls.filter((c) => c.method === "POST" && c.body?.["preview"] === undefined).map((c) => c.body)).toEqual([{ pattern: "ikea", match: "prefix", category_id: "hushall" }]);
  });
});
