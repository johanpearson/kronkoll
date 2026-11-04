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
    { id: "hushall", parent_id: null, name: "Hushåll", kind: "expense", archived: false },
    { id: "hushall-forbrukning", parent_id: "hushall", name: "Förbrukning", kind: "expense", archived: false },
    { id: "fritid", parent_id: null, name: "Fritid", kind: "expense", archived: false },
    { id: "fritid-hobby", parent_id: "fritid", name: "Hobby", kind: "expense", archived: false },
  ],
};

/** Påhittad transaktion (KK-13) i API:ts form. */
function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    account: { id: "acc_1", name: "Privatkonto ••7466", type: "checking" },
    status: "pending",
    transaction_date: "2026-11-01",
    booking_date: null,
    amount_minor: -41250,
    counterparty: "K*ICA NARA SOFO 4711 STHLM",
    counterparty_norm: "ICA NARA SOFO",
    description: "Kortköp 2026-11-01",
    category_id: "mat-livsmedel",
    category_source: "template",
    is_internal_transfer: false,
    manual_transfer: null,
    transfer_pair: null,
    splits: [],
    ...overrides,
  };
}

type Call = { method: string; path: string; body: unknown; csrf: string | null };

function api(first: Record<string, unknown>, after?: Record<string, unknown>, transferStatus = 200) {
  const calls: Call[] = [];
  let detailCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null, csrf: new Headers(init?.headers).get("x-kronkoll") });
      const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/categories") return respond(200, CATEGORIES);
      if (url.pathname.endsWith("/transfer")) return respond(transferStatus, { transaction_id: "t1", internal: true, manual: true });
      if (url.pathname === "/api/transactions/t1") return respond(200, ++detailCalls === 1 ? first : (after ?? first));
      return respond(404, { error: "not_found" });
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

async function open(path = "/transaktioner/t1") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const row = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

describe("detaljsidan för en transaktion (#32)", () => {
  it("visar belopp, datum, status, konto och kategori med källa", async () => {
    api(detail());
    await open();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("K*ICA NARA SOFO 4711 STHLM");
    expect(document.querySelector("main .amount.big")?.textContent).toBe(formatSek(-41250));
    expect(row("Status")).toBe("Preliminär – väntar på bokföring");
    expect(row("Datum")).toBe("1 nov. 2026");
    expect(row("Konto")).toBe("Privatkonto ••7466");
    expect(row("Kategori")).toBe("Mat › Livsmedel (mall)");
  });

  it("visar bankens råa text, så att en okänd motpart går att förstå (KK-30)", async () => {
    api(detail({ counterparty: "<b>Okänd</b>", description: "Swish från mamma" }));
    await open();
    const bank = screen.getByRole("region", { name: "Från banken" });
    expect(within(bank).getByText("<b>Okänd</b>")).toBeDefined();
    expect(within(bank).getByText("Swish från mamma")).toBeDefined();
    expect(within(bank).getByText("ICA NARA SOFO")).toBeDefined();
    expect(document.querySelector("main b")).toBeNull();
  });

  it("en bokförd transaktion visar bokföringsdatumet", async () => {
    api(detail({ status: "booked", booking_date: "2026-11-03", category_source: "manual" }));
    await open();
    expect(row("Status")).toBe("Bokförd 3 nov. 2026");
    expect(row("Kategori")).toBe("Mat › Livsmedel (vald av dig)");
  });

  it("visar en intern överföring med sin motpost, och uppdelningens delar", async () => {
    api(
      detail({
        is_internal_transfer: true,
        transfer_pair: { id: "t2", account_name: "Sparkonto", amount_minor: 500000, transaction_date: "2026-11-02" },
        splits: [
          { category_id: "hushall-forbrukning", amount_minor: -30000 },
          { category_id: "fritid-hobby", amount_minor: -11250 },
        ],
      }),
    );
    await open();
    expect(row("Räknas")).toBe("Nej – intern överföring (automatiskt)");
    expect(row("Motpost")).toBe(`Sparkonto · ${formatSek(500000)} · 2 nov. 2026`);
    const parts = screen.getByRole("list", { name: "Uppdelning" });
    expect(within(parts).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      `Hushåll › Förbrukning ${formatSek(-30000)}`,
      `Fritid › Hobby ${formatSek(-11250)}`,
    ]);
  });

  it("\"Räkna inte\" sparar valet och visar den nya statusen (KK-20-C, KK-39-A)", async () => {
    const calls = api(detail(), detail({ is_internal_transfer: true, manual_transfer: true }));
    await open();
    expect(row("Räknas")).toBe("Ja");
    fireEvent.click(screen.getByRole("button", { name: "Räkna inte" }));
    await settle();
    expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", path: "/api/transactions/t1/transfer", body: { internal: true }, csrf: "1" });
    expect(row("Räknas")).toBe("Nej (vald av dig)");
    expect(screen.getByRole("button", { name: "Räkna med" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Låt Kronkoll avgöra" })).toBeDefined();
  });

  it("\"Räkna med\" ångrar valet (KK-39-B)", async () => {
    const calls = api(detail({ is_internal_transfer: true, manual_transfer: true }), detail({ manual_transfer: false }));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Räkna med" }));
    await settle();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ internal: false });
    expect(row("Räknas")).toBe("Ja (vald av dig)");
  });

  it("\"Låt Kronkoll avgöra\" tar bort ditt val", async () => {
    const calls = api(detail({ is_internal_transfer: true, manual_transfer: true }), detail());
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Låt Kronkoll avgöra" }));
    await settle();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ internal: null });
    expect(row("Räknas")).toBe("Ja");
  });

  it("visar ett fel när valet inte går att spara", async () => {
    api(detail(), undefined, 503);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Räkna inte" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara. Försök igen.");
  });

  it("Ändra kategori och Dela upp öppnas på sidan", async () => {
    api(detail());
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra kategori" }));
    expect(screen.getByRole("combobox", { name: "Kategori" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    fireEvent.click(screen.getByRole("button", { name: "Dela upp" }));
    await settle();
    expect(screen.getByRole("button", { name: "Spara uppdelning" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Avbryt uppdelning" }));
    await settle();
    expect(screen.queryByRole("button", { name: "Spara uppdelning" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dela upp" })).toBeDefined();
  });

  it.each([
    [{ category_id: null, category_source: "none" }, "Kategori", "Okategoriserad"],
    [{ category_source: "learned" }, "Kategori", "Mat › Livsmedel (inlärd regel)"],
    [{ splits: [{ category_id: "mat-livsmedel", amount_minor: -41250 }] }, "Kategori", "Uppdelad"],
    [{ manual_transfer: false }, "Räknas", "Ja (vald av dig)"],
  ])("visar %j som %s: %s", async (overrides, label, value) => {
    api(detail(overrides));
    await open();
    expect(row(label)).toBe(value);
  });

  it("utan motpart blir beskrivningen rubrik, och utan båda en neutral text", async () => {
    api(detail({ counterparty: "", description: "" }));
    await open();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Okänd motpart");
    expect(within(screen.getByRole("region", { name: "Från banken" })).getAllByText("–")).toHaveLength(2);
  });

  it("visar ett fel när transaktionen inte går att hämta", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 503 }))));
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta transaktionen. Försök igen om en stund.");
  });

  it("en sparad kategori hämtar om sidan när redigeraren stängs", async () => {
    const calls = api(detail(), detail({ category_id: "hushall-forbrukning", category_source: "manual" }));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra kategori" }));
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    await settle();
    expect(calls.filter((c) => c.path === "/api/transactions/t1").length).toBe(2);
    expect(row("Kategori")).toBe("Hushåll › Förbrukning (vald av dig)");
  });

  it("en transaktion som inte finns visar ett tydligt besked och väg tillbaka", async () => {
    api(detail());
    await open("/transaktioner/saknas");
    expect(screen.getByRole("alert").textContent).toBe("Transaktionen finns inte.");
    expect(screen.getByRole("link", { name: "Till transaktionerna" })).toBeDefined();
  });

  it("namnet i listan leder till detaljsidan, och fliken Transaktioner är markerad där", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
        const body = path.startsWith("/api/categories")
          ? CATEGORIES
          : path.startsWith("/api/transactions/t1")
            ? detail()
            : { period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" }, items: [{ id: "t1", status: "pending", transaction_date: "2026-11-01", amount_minor: -41250, counterparty: "ICA Nära Sofo", description: "", category_id: null, is_internal_transfer: false, split: false }], next_cursor: null };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    await open("/transaktioner");
    fireEvent.click(screen.getByRole("link", { name: "ICA Nära Sofo" }));
    await settle();
    expect(window.location.pathname).toBe("/transaktioner/t1");
    expect(within(screen.getByRole("navigation", { name: "Huvudmeny" })).getByRole("link", { name: "Transaktioner" }).getAttribute("aria-current")).toBe("page");
  });
});
