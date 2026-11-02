// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { parseKronor } from "./SplitEditor.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const NOVEMBER = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };
const CATEGORIES = {
  items: [
    { id: "hushall", parent_id: null, name: "Hushåll", kind: "expense", archived: false },
    { id: "hushall-forbrukning", parent_id: "hushall", name: "Förbrukning", kind: "expense", archived: false },
    { id: "fritid", parent_id: null, name: "Fritid", kind: "expense", archived: false },
    { id: "fritid-hobby", parent_id: "fritid", name: "Hobby", kind: "expense", archived: false },
  ],
};

/** Påhittad transaktion (KK-13): ett köp på 1 240 kr. */
const RECEIPT = {
  id: "t1",
  account_id: "acc_1",
  status: "booked",
  transaction_date: "2026-10-31",
  booking_date: "2026-10-31",
  amount_minor: -124000,
  counterparty: "CLAS OHLSON",
  description: "",
  category_id: null,
  category_source: "none",
  is_internal_transfer: false,
  split: false,
};

type Call = { method: string; path: string; body: unknown; csrf: string | null };

function api(options: { existing?: unknown[]; split?: boolean; put?: [number, unknown] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null, csrf: new Headers(init?.headers).get("x-kronkoll") });
      const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/categories") return respond(200, CATEGORIES);
      if (url.pathname === "/api/transactions/t1/splits" && method === "GET") return respond(200, { transaction_id: "t1", amount_minor: -124000, parts: options.existing ?? [] });
      if (method === "PUT") return respond(...(options.put ?? [200, { transaction_id: "t1", parts: 2 }]));
      return respond(200, { period: NOVEMBER, items: [{ ...RECEIPT, split: options.split ?? false }], next_cursor: null });
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openSplit() {
  window.history.replaceState(null, "", "/transaktioner");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Dela upp CLAS OHLSON" }));
  await settle();
}

function fill(part: number, categoryId: string, amount: string) {
  fireEvent.change(screen.getByRole("combobox", { name: `Kategori för del ${String(part)}` }), { target: { value: categoryId } });
  fireEvent.change(screen.getByRole("textbox", { name: `Belopp för del ${String(part)}` }), { target: { value: amount } });
}

const remaining = () => screen.getByText(/^Kvar att fördela:/u).textContent.replace(/\s/gu, " ");

describe("dela upp en transaktion (KK-19, #32)", () => {
  it("börjar med två tomma delar och visar hela beloppet som kvar att fördela", async () => {
    api();
    await openSplit();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(remaining()).toBe("Kvar att fördela: 1 240,00 kr");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Spara uppdelning" }).disabled).toBe(true);
  });

  it("räknar kvar att fördela medan man skriver, och sparar med transaktionens tecken (KK-19-A)", async () => {
    const calls = api();
    await openSplit();
    fill(1, "hushall-forbrukning", "900");
    fill(2, "fritid-hobby", "300");
    expect(remaining()).toBe("Kvar att fördela: 40,00 kr");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Spara uppdelning" }).disabled).toBe(true);
    fill(2, "fritid-hobby", "340,00");
    expect(remaining()).toBe("Kvar att fördela: 0,00 kr");
    fireEvent.click(screen.getByRole("button", { name: "Spara uppdelning" }));
    await settle();
    expect(calls.find((c) => c.method === "PUT")).toEqual({
      method: "PUT",
      path: "/api/transactions/t1/splits",
      body: { parts: [{ category_id: "hushall-forbrukning", amount_minor: -90000 }, { category_id: "fritid-hobby", amount_minor: -34000 }] },
      csrf: "1",
    });
    expect(screen.getByText("CLAS OHLSON").closest("li")?.textContent).toContain("Uppdelad");
    expect(screen.queryByRole("button", { name: "Spara uppdelning" })).toBeNull();
  });

  it("lägger till och tar bort delar", async () => {
    api();
    await openSplit();
    fireEvent.click(screen.getByRole("button", { name: "Lägg till del" }));
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Ta bort del 3" }));
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });

  it("ett belopp som inte går att tolka gör att uppdelningen inte går att spara", async () => {
    api();
    await openSplit();
    fill(1, "hushall-forbrukning", "nio hundra");
    fill(2, "fritid-hobby", "1240");
    expect(screen.getByText("Belopp för del 1 är inte ett giltigt belopp.")).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Spara uppdelning" }).disabled).toBe(true);
  });

  it("visar en befintlig uppdelning och kan ta bort den", async () => {
    const calls = api({
      split: true,
      existing: [
        { category_id: "hushall-forbrukning", amount_minor: -90000 },
        { category_id: "fritid-hobby", amount_minor: -34000 },
      ],
      put: [200, { transaction_id: "t1", parts: 0 }],
    });
    await openSplit();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Belopp för del 1" }).value).toBe("900,00");
    expect(remaining()).toBe("Kvar att fördela: 0,00 kr");
    fireEvent.click(screen.getByRole("button", { name: "Ta bort uppdelning" }));
    await settle();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ parts: [] });
    expect(screen.getByText("CLAS OHLSON").closest("li")?.textContent).not.toContain("Uppdelad");
  });

  it("visar serverns besked om delarna inte stämmer (KK-19-B)", async () => {
    api({ put: [422, { error: "split_sum_mismatch", expected_minor: -124000, actual_minor: -120000, remaining_minor: -4000 }] });
    await openSplit();
    fill(1, "hushall-forbrukning", "900");
    fill(2, "fritid-hobby", "340");
    fireEvent.click(screen.getByRole("button", { name: "Spara uppdelning" }));
    await settle();
    expect(screen.getByRole("alert").textContent.replace(/\s/gu, " ")).toBe("Delarna stämmer inte med beloppet. Kvar att fördela: 40,00 kr.");
  });

  it("visar ett allmänt fel när uppdelningen inte går att spara", async () => {
    api({ put: [503, { error: "unavailable" }] });
    await openSplit();
    fill(1, "hushall-forbrukning", "900");
    fill(2, "fritid-hobby", "340");
    fireEvent.click(screen.getByRole("button", { name: "Spara uppdelning" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara uppdelningen. Försök igen.");
  });

  it("Avbryt stänger utan att spara", async () => {
    const calls = api();
    await openSplit();
    fireEvent.click(screen.getByRole("button", { name: "Avbryt uppdelning" }));
    expect(screen.queryByRole("button", { name: "Spara uppdelning" })).toBeNull();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("svenska belopp i kronor (KK-4)", () => {
  it.each([
    ["900", 90000],
    ["340,50", 34050],
    ["1 240,00", 124000],
    ["1 240", 124000],
    ["12.5", 1250],
  ])("%j → %i öre", (text, ore) => {
    expect(parseKronor(text)).toBe(ore);
  });

  it.each(["", "nio", "1,234", "-5", "0"])("%j är inget giltigt belopp", (text) => {
    expect(parseKronor(text)).toBeNull();
  });
});
