// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const NOVEMBER = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };
const CATEGORIES = {
  items: [
    { id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false },
    { id: "mat-livsmedel", parent_id: "mat", name: "Livsmedel", kind: "expense", archived: false },
    { id: "hushall", parent_id: null, name: "Hushåll", kind: "expense", archived: false },
    { id: "hushall-forbrukning", parent_id: "hushall", name: "Förbrukning", kind: "expense", archived: false },
    { id: "gammal", parent_id: null, name: "Gammal", kind: "expense", archived: true },
  ],
};

/** Påhittad transaktion (KK-13) i API:ts form. */
const ICA = {
  id: "t1",
  account_id: "acc_1",
  status: "booked",
  transaction_date: "2026-11-01",
  booking_date: "2026-11-01",
  amount_minor: -41250,
  counterparty: "ICA Nära Sofo",
  description: "",
  category_id: null,
  category_source: "none",
  is_internal_transfer: false,
  split: false,
};

type Call = { method: string; path: string; body: unknown; csrf: string | null };

/** Ett API som svarar per metod och sökväg och minns alla anrop. */
function api(answers: { patch?: [number, unknown]; apply?: [number, unknown] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
        csrf: new Headers(init?.headers).get("x-kronkoll"),
      });
      const respond = ([status, body]: [number, unknown]) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/categories") return respond([200, CATEGORIES]);
      if (method === "PATCH") return respond(answers.patch ?? [200, {}]);
      if (url.pathname.endsWith("/apply")) return respond(answers.apply ?? [200, {}]);
      return respond([200, { period: NOVEMBER, items: [ICA], next_cursor: null }]);
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

async function openEditor() {
  window.history.replaceState(null, "", "/transaktioner");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Ändra kategori för ICA Nära Sofo" }));
}

const saved = (rule: unknown, candidates: number, protectedManual: number): [number, unknown] => [
  200,
  { transaction: { id: "t1", category_id: "hushall-forbrukning", category_source: "manual" }, rule, retroactive_candidates: candidates, protected_manual: protectedManual },
];
const RULE = { id: "r-1", match: "counterparty_prefix", pattern: "ICA NARA SOFO", category_id: "hushall-forbrukning" };

describe("byta kategori (KK-18-B, KK-18-C, #32)", () => {
  it("visar de kategorier som går att välja, med huvudkategori och utan arkiverade", async () => {
    api();
    await openEditor();
    const options = [...screen.getByRole<HTMLSelectElement>("combobox", { name: "Kategori" }).options].map((o) => o.textContent);
    expect(options).toEqual(["Välj kategori", "Hushåll", "Hushåll › Förbrukning", "Mat", "Mat › Livsmedel"]);
    expect(screen.getByRole("checkbox", { name: "Gör alltid så för ICA Nära Sofo" })).toBeDefined();
  });

  it("sparar en manuell kategori med CSRF-header och visar den nya kategorin i listan", async () => {
    const calls = api({ patch: saved(null, 0, 0) });
    await openEditor();
    fireEvent.change(screen.getByRole("combobox", { name: "Kategori" }), { target: { value: "hushall-forbrukning" } });
    fireEvent.click(screen.getByRole("button", { name: "Spara" }));
    await settle();
    expect(calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", path: "/api/transactions/t1", body: { category_id: "hushall-forbrukning", learn_rule: false }, csrf: "1" });
    expect(screen.getByText("ICA Nära Sofo").closest("li")?.textContent).toContain("Hushåll › Förbrukning");
    expect(screen.queryByRole("button", { name: "Spara" })).toBeNull();
  });

  it("\"Gör alltid så\" frågar om regeln ska gälla tidigare transaktioner, och applicerar den på ja", async () => {
    const calls = api({ patch: saved(RULE, 23, 2), apply: [200, { updated: 23, skipped_manual: 2 }] });
    await openEditor();
    fireEvent.change(screen.getByRole("combobox", { name: "Kategori" }), { target: { value: "hushall-forbrukning" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Gör alltid så för ICA Nära Sofo" }));
    fireEvent.click(screen.getByRole("button", { name: "Spara" }));
    await settle();
    // Hela namnet är förvalt.
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ category_id: "hushall-forbrukning", learn_rule: true, rule_pattern: "ICA NÄRA SOFO" });
    expect(screen.getByText("Regeln matchar 23 tidigare transaktioner. 2 manuellt valda ändras inte.")).toBeDefined();
    const listBefore = calls.filter((c) => c.path === "/api/transactions").length;
    fireEvent.click(screen.getByRole("button", { name: "Applicera på dem" }));
    await settle();
    expect(calls.find((c) => c.path === "/api/rules/r-1/apply")).toMatchObject({ method: "POST", csrf: "1" });
    expect(screen.getByRole("status").textContent).toBe("23 transaktioner fick den nya kategorin.");
    expect(calls.filter((c) => c.path === "/api/transactions").length).toBeGreaterThan(listBefore);
  });

  it("med Gör alltid så går det att välja en kortare början av namnet, så att regeln gäller hela kedjan", async () => {
    const calls = api({ patch: saved({ ...RULE, pattern: "ICA" }, 0, 0) });
    await openEditor();
    expect(screen.queryByRole("group", { name: "Gäller" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Kategori" }), { target: { value: "mat-livsmedel" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Gör alltid så för ICA Nära Sofo" }));
    const group = screen.getByRole("group", { name: "Gäller" });
    expect([...group.querySelectorAll("label")].map((l) => l.textContent)).toEqual([
      "Allt som börjar med ICA NÄRA SOFO",
      "Allt som börjar med ICA NÄRA",
      "Allt som börjar med ICA",
    ]);
    fireEvent.click(screen.getByRole("radio", { name: "Allt som börjar med ICA" }));
    fireEvent.click(screen.getByRole("button", { name: "Spara" }));
    await settle();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ category_id: "mat-livsmedel", learn_rule: true, rule_pattern: "ICA" });
  });

  it("\"Inte nu\" stänger frågan utan att ändra historiken", async () => {
    const calls = api({ patch: saved(RULE, 5, 0) });
    await openEditor();
    fireEvent.change(screen.getByRole("combobox", { name: "Kategori" }), { target: { value: "hushall-forbrukning" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Gör alltid så för ICA Nära Sofo" }));
    fireEvent.click(screen.getByRole("button", { name: "Spara" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Inte nu" }));
    expect(calls.some((c) => c.path.endsWith("/apply"))).toBe(false);
    expect(screen.queryByText(/Regeln matchar/u)).toBeNull();
  });

  it("frågar inte när regeln inte matchar något tidigare", async () => {
    api({ patch: saved(RULE, 0, 0) });
    await openEditor();
    fireEvent.change(screen.getByRole("combobox", { name: "Kategori" }), { target: { value: "hushall-forbrukning" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Gör alltid så för ICA Nära Sofo" }));
    fireEvent.click(screen.getByRole("button", { name: "Spara" }));
    await settle();
    expect(screen.queryByText(/Regeln matchar/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Spara" })).toBeNull();
  });

  it("Spara går inte att trycka utan vald kategori, och Avbryt stänger", async () => {
    const calls = api();
    await openEditor();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Spara" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(screen.queryByRole("combobox", { name: "Kategori" })).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("visar ett fel när kategorin inte går att spara, och listan är oförändrad", async () => {
    api({ patch: [503, { error: "unavailable" }] });
    await openEditor();
    fireEvent.change(screen.getByRole("combobox", { name: "Kategori" }), { target: { value: "hushall-forbrukning" } });
    fireEvent.click(screen.getByRole("button", { name: "Spara" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara kategorin. Försök igen.");
    expect(screen.getByText("ICA Nära Sofo").closest("li")?.textContent).toContain("Okategoriserad");
  });

  it("visar ett fel när regeln inte går att applicera", async () => {
    api({ patch: saved(RULE, 3, 0), apply: [503, { error: "unavailable" }] });
    await openEditor();
    fireEvent.change(screen.getByRole("combobox", { name: "Kategori" }), { target: { value: "hushall-forbrukning" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Gör alltid så för ICA Nära Sofo" }));
    fireEvent.click(screen.getByRole("button", { name: "Spara" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Applicera på dem" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att applicera regeln. Försök igen.");
  });
});
