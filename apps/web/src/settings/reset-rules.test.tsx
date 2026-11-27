// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const RULES = { items: [{ id: "r-ica", match: "counterparty_prefix", pattern: "ICA", category_id: "mat", source: "template", hits: 2, category_archived: false }] };
type Call = { method: string; path: string; body: unknown };

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
      if (url.pathname === "/api/categories") return json(200, { items: [{ id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false }] });
      if (url.pathname === "/api/rules/reset") {
        if ((body as { preview?: boolean }).preview === true) return json(...(options.preview ?? [200, { rules: 14, exclude_rules: 2, categorized_by_rules: 120, categorized: 130 }]));
        if ((options.reset ?? 200) === 200) cleared = true;
        return json(options.reset ?? 200, { reset: true });
      }
      if (url.pathname === "/api/rules") return json(200, cleared ? { items: [] } : RULES);
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
  window.history.replaceState(null, "", "/installningar/regler");
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

const dialog = () => screen.getByRole("region", { name: "Ta bort alla regler?" });

describe("ta bort alla regler (KK-51)", () => {
  it("räknar först och säger vad som berörs, och Avbryt ändrar ingenting", async () => {
    const calls = api();
    await open();
    await click("Ta bort alla regler");
    expect(dialog().textContent).toContain("14 regler som ger en kategori och 2 regler som gör att något inte räknas tas bort.");
    expect(dialog().textContent).toContain("Det som reglerna höll utanför räknas igen.");
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Ta även bort kategorin som regler har satt (120 transaktioner)" }).checked).toBe(true);
    expect(screen.getByRole("radio", { name: "Ta bort alla kategorier på transaktionerna, även de du valt själv (130)" })).toBeTruthy();
    await click("Avbryt", dialog());
    expect(screen.queryByRole("region", { name: "Ta bort alla regler?" })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/api/rules/reset", body: { preview: true } }]);
  });

  it("tar bort alla efter bekräftelse och visar en tom lista", async () => {
    const calls = api();
    await open();
    expect(screen.getByRole("link", { name: "Rensa alla kategorier" }).getAttribute("href")).toBe("/installningar/kategorier");
    await click("Ta bort alla regler");
    await click("Ta bort alla regler", dialog());
    expect(calls.find((c) => (c.body as { confirm?: boolean } | null)?.confirm === true)).toEqual({ method: "POST", path: "/api/rules/reset", body: { confirm: true, uncategorize: "rules" } });
    expect(screen.getByRole("status").textContent).toBe("Alla regler är borttagna och transaktionerna är okategoriserade.");
    expect(screen.getByText("Inga regler matchar.")).toBeTruthy();
  });

  it("går att välja att ta bort alla kategorier eller att behålla dem", async () => {
    const calls = api();
    await open();
    await click("Ta bort alla regler");
    fireEvent.click(screen.getByRole("radio", { name: /Ta bort alla kategorier på transaktionerna/u }));
    await click("Ta bort alla regler", dialog());
    expect(calls.find((c) => (c.body as { confirm?: boolean } | null)?.confirm === true)?.body).toEqual({ confirm: true, uncategorize: "all" });
    cleanup();
    const keep = api();
    await open();
    await click("Ta bort alla regler");
    fireEvent.click(screen.getByRole("radio", { name: "Låt transaktionerna behålla sina kategorier" }));
    await click("Ta bort alla regler", dialog());
    expect(keep.find((c) => (c.body as { confirm?: boolean } | null)?.confirm === true)?.body).toEqual({ confirm: true, uncategorize: "none" });
    expect(screen.getByRole("status").textContent).toBe("Alla regler är borttagna.");
  });

  it("utan antal kategoriserade visas noll", async () => {
    api({ preview: [200, { rules: 0, exclude_rules: 0 }] });
    await open();
    await click("Ta bort alla regler");
    expect(screen.getByRole("radio", { name: "Ta även bort kategorin som regler har satt (0 transaktioner)" })).toBeTruthy();
  });

  it("säger till när räkningen eller borttagningen inte går, och ingenting ändras", async () => {
    api({ preview: [503, { error: "unavailable" }] });
    await open();
    await click("Ta bort alla regler");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att räkna reglerna. Försök igen.");
    cleanup();
    api({ preview: [200, { rules: "x" }] });
    await open();
    await click("Ta bort alla regler");
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att räkna");
    cleanup();
    api({ reset: 503 });
    await open();
    await click("Ta bort alla regler");
    await click("Ta bort alla regler", dialog());
    expect(within(dialog()).getByRole("alert").textContent).toBe("Det gick inte att ta bort reglerna. Ingenting är ändrat. Försök igen.");
    expect(screen.getByRole("list", { name: "Regler" })).toBeTruthy();
  });
});
