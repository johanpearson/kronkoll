// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const NOVEMBER = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };

/** Påhittade transaktioner (KK-13) i API:ts form. */
function tx(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    account_id: "acc_1",
    status: "booked",
    transaction_date: "2026-11-01",
    booking_date: "2026-11-01",
    amount_minor: -10000,
    counterparty: name,
    description: "",
    category_id: null,
    category_source: "none",
    is_internal_transfer: false,
    manual_transfer: null,
    split: false,
    hidden: false,
    ...extra,
  };
}

type Call = { method: string; url: URL; body: unknown };

/** Ett API med synliga och dolda transaktioner, där döljandet flyttar dem. */
function api(options: { hide?: [number, unknown] } = {}) {
  const calls: Call[] = [];
  const visible = [tx("a", "Kaffebaren"), tx("b", "Påhittade Möbler AB"), tx("c", "<b>Fet</b> butik")];
  const hidden = [tx("d", "Dold butik", { hidden: true, is_internal_transfer: true })];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/categories" || url.pathname === "/api/accounts") return json(200, { items: [] });
      calls.push({ method, url, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null });
      if (url.pathname === "/api/transactions/hide") return json(...(options.hide ?? [200, { updated: 2, hidden: true }]));
      return json(200, { period: NOVEMBER, items: url.searchParams.get("hidden") === "true" ? hidden : visible, next_cursor: null });
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
  window.history.replaceState(null, "", "/transaktioner");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

async function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
  await settle();
}

const hideCalls = (calls: Call[]) => calls.filter((c) => c.url.pathname === "/api/transactions/hide").map((c) => c.body);

describe("välj flera och dölj transaktioner (KK-49)", () => {
  it("Välj flera visar kryssrutor i stället för åtgärderna, och Dölj skickar de valda och hämtar om listan (KK-49-A)", async () => {
    const calls = api();
    await open();
    expect(screen.queryByRole("checkbox", { name: "Välj Kaffebaren" })).toBeNull();
    await click("Välj flera");
    expect(screen.queryByRole("button", { name: "Ändra kategori för Kaffebaren" })).toBeNull();
    expect(screen.getByText("Välj transaktioner i listan.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Dölj" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Kaffebaren" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Påhittade Möbler AB" }));
    expect(screen.getByText("2 valda")).toBeTruthy();
    // Att välja bort tar bort den ur urvalet.
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Påhittade Möbler AB" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Påhittade Möbler AB" }));
    const before = calls.filter((c) => c.url.pathname === "/api/transactions").length;
    await click("Dölj");
    expect(hideCalls(calls)).toEqual([{ ids: ["a", "b"], hidden: true }]);
    expect(screen.getByRole("status").querySelector("p")?.textContent).toBe("2 transaktioner är dolda. De finns under Visa dolda.");
    expect(calls.filter((c) => c.url.pathname === "/api/transactions").length).toBe(before + 1);
    // Urvalet är avslutat.
    expect(screen.queryByRole("region", { name: "Valda transaktioner" })).toBeNull();
    expect(screen.getByRole("button", { name: "Välj flera" })).toBeTruthy();
  });

  it("Ångra i notisen visar de dolda igen och hämtar om listan (KK-64-F)", async () => {
    const calls = api();
    await open();
    await click("Välj flera");
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Kaffebaren" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Påhittade Möbler AB" }));
    await click("Dölj");
    const before = calls.filter((c) => c.url.pathname === "/api/transactions").length;
    await click("Ångra");
    expect(hideCalls(calls)).toEqual([
      { ids: ["a", "b"], hidden: true },
      { ids: ["a", "b"], hidden: false },
    ]);
    expect(calls.filter((c) => c.url.pathname === "/api/transactions").length).toBe(before + 1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("säger till om det inte gick att ångra", async () => {
    const calls = api();
    await open();
    await click("Välj flera");
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Kaffebaren" }));
    await click("Dölj");
    vi.mocked(fetch).mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })));
    await click("Ångra");
    expect(screen.getByRole("alert").querySelector("p")?.textContent).toBe("Det gick inte att ångra. Försök igen.");
    expect(hideCalls(calls)).toHaveLength(1);
  });

  it("en transaktion i singular, och bankens text i namnet visas som text (KK-30)", async () => {
    api({ hide: [200, { updated: 1, hidden: true }] });
    await open();
    await click("Välj flera");
    expect(screen.getByRole("checkbox", { name: "Välj <b>Fet</b> butik" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Kaffebaren" }));
    await click("Dölj");
    expect(screen.getByRole("status").querySelector("p")?.textContent).toBe("1 transaktion är dold. De finns under Visa dolda.");
  });

  it("Avbryt avslutar urvalet utan att skicka något", async () => {
    const calls = api();
    await open();
    await click("Välj flera");
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Kaffebaren" }));
    await click("Avbryt");
    expect(hideCalls(calls)).toEqual([]);
    expect(screen.queryByRole("checkbox", { name: "Välj Kaffebaren" })).toBeNull();
  });

  it("Visa dolda listar de dolda med texten Dold, och Visa igen visar dem igen (KK-49-B)", async () => {
    const calls = api({ hide: [200, { updated: 1, hidden: false }] });
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Visa dolda" }));
    await settle();
    expect(calls.at(-1)?.url.search).toContain("hidden=true");
    const row = within(screen.getByRole("main")).getByText("Dold butik").closest("li") as HTMLElement;
    expect(row.querySelector(".tx-notes")?.textContent).toBe("Dold · Okategoriserad");
    expect(row.textContent).not.toContain("räknas inte");
    await click("Välj flera");
    expect(screen.queryByText("Dolda syns inte i listan", { exact: false })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Dold butik" }));
    await click("Visa igen");
    expect(hideCalls(calls)).toEqual([{ ids: ["d"], hidden: false }]);
    expect(screen.getByRole("status").querySelector("p")?.textContent).toBe("1 transaktion visas igen.");
  });

  it("att byta till dolda avslutar ett pågående urval", async () => {
    api();
    await open();
    await click("Välj flera");
    fireEvent.click(screen.getByRole("checkbox", { name: "Visa dolda" }));
    await settle();
    expect(screen.queryByRole("region", { name: "Valda transaktioner" })).toBeNull();
    expect(screen.getByText("Dold butik")).toBeTruthy();
  });

  it("säger till när det inte gick, och urvalet finns kvar", async () => {
    api({ hide: [503, { error: "unavailable" }] });
    await open();
    await click("Välj flera");
    fireEvent.click(screen.getByRole("checkbox", { name: "Välj Kaffebaren" }));
    await click("Dölj");
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att ändra. Ingenting är ändrat. Försök igen.");
    expect(screen.getByText("1 valda")).toBeTruthy();
  });
});
