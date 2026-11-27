// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = { items: [{ id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false }] };
const SUMMARY = { categories: 37, rules: 14, transactions: 812, splits: 3, budget_lines: 9 };

type Call = { method: string; path: string; body: unknown };

/** Ett API som har kategorier tills en rensning lyckas. */
function api(options: { preview?: [number, unknown]; reset?: number } = {}) {
  const calls: Call[] = [];
  let cleared = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, path: url.pathname, body });
      const json = (status: number, payload: unknown) => Promise.resolve(new Response(JSON.stringify(payload), { status }));
      if (url.pathname === "/api/categories/reset") {
        if ((body as { preview?: boolean }).preview === true) return json(...(options.preview ?? [200, SUMMARY]));
        if ((options.reset ?? 200) === 200) cleared = true;
        return json(options.reset ?? 200, { reset: true });
      }
      if (url.pathname === "/api/categories") return json(200, cleared ? { items: [] } : CATEGORIES);
      return json(404, { error: "not_found" });
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function open() {
  window.history.replaceState(null, "", "/installningar/kategorier");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

async function click(name: string, scope: HTMLElement = document.body) {
  fireEvent.click(within(scope).getByRole("button", { name }));
  await settle();
}

const dialog = () => screen.getByRole("region", { name: "Rensa alla kategorier" });

describe("börja om med kategorierna (KK-48)", () => {
  it("räknar först och säger vad som berörs, och Avbryt ändrar ingenting (KK-48-A)", async () => {
    const calls = api();
    await open();
    await click("Rensa alla kategorier");
    expect(dialog().textContent).toContain("37 kategorier och 14 regler tas bort, 812 transaktioner blir okategoriserade, 3 uppdelningar och 9 budgetrader tas bort.");
    expect(dialog().textContent).toContain("Inga transaktioner raderas och inget hos banken ändras.");
    await click("Avbryt", dialog());
    expect(screen.queryByRole("region", { name: "Rensa alla kategorier" })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/api/categories/reset", body: { preview: true } }]);
  });

  it("rensar efter bekräftelse och visar en tom lista med en uppmaning (KK-48-B)", async () => {
    const calls = api();
    await open();
    await click("Rensa alla kategorier");
    await click("Rensa alla kategorier", dialog());
    expect(calls.find((c) => (c.body as { confirm?: boolean } | null)?.confirm === true)).toEqual({ method: "POST", path: "/api/categories/reset", body: { confirm: true, restore_template: false } });
    expect(screen.getByRole("status").textContent).toBe("Alla kategorier är rensade. Lägg till nya från början.");
    expect(screen.getByText("Det finns inga kategorier. Lägg till en huvudkategori för att komma igång.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Utgifter" })).toBeNull();
  });

  it("med mallen vald skickas restore_template och bekräftelsen säger det", async () => {
    const calls = api();
    await open();
    await click("Rensa alla kategorier");
    fireEvent.click(screen.getByRole("checkbox", { name: /Sätt tillbaka mallens kategorier/u }));
    await click("Rensa alla kategorier", dialog());
    expect(calls.find((c) => (c.body as { confirm?: boolean } | null)?.confirm === true)?.body).toEqual({ confirm: true, restore_template: true });
    expect(screen.getByRole("status").textContent).toBe("Kategorierna är återställda till mallen.");
  });

  it("säger till när räkningen eller rensningen inte går, och inget ändras", async () => {
    api({ preview: [503, { error: "unavailable" }] });
    await open();
    await click("Rensa alla kategorier");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att räkna vad som berörs. Försök igen.");
    cleanup();
    api({ preview: [200, { categories: "x" }] });
    await open();
    await click("Rensa alla kategorier");
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att räkna");
    cleanup();
    api({ reset: 503 });
    await open();
    await click("Rensa alla kategorier");
    await click("Rensa alla kategorier", dialog());
    expect(within(dialog()).getByRole("alert").textContent).toBe("Det gick inte att rensa. Ingenting är ändrat. Försök igen.");
    expect(screen.getByRole("list", { name: "Utgifter" })).toBeTruthy();
  });
});
