// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { knownAccountLabel, toLinkedKnownAccount } from "./KnownAccountLink.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittad överföring (KK-13) i API:ts form, utan motpart som hos Skandia. */
function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    account: { id: "acc_1", name: "Privatkonto ••7466", type: "checking" },
    status: "booked",
    transaction_date: "2026-11-02",
    booking_date: "2026-11-02",
    amount_minor: -200_000,
    counterparty: "",
    counterparty_norm: "",
    description: "Swish till Exempel",
    category_id: null,
    category_source: "none",
    is_internal_transfer: false,
    manual_transfer: null,
    transfer_pair: null,
    splits: [],
    loan: null,
    known_account: null,
    ...overrides,
  };
}

const ACCOUNTS = { known_accounts: [{ id: "k1", name: "<b>Konto A</b>", match_patterns: ["SWISH"], category_id: "mat" }, { id: "k2", name: "Barnspar", match_patterns: ["BARN"], category_id: null }] };

function api(details: Record<string, unknown>[], options: { accounts?: [number, unknown]; put?: number } = {}) {
  const puts: { path: string; body: unknown }[] = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (init?.method === "PUT") {
        puts.push({ path: url.pathname, body: JSON.parse(init.body as string) as unknown });
        return respond(options.put ?? 200, {});
      }
      if (url.pathname === "/api/known-accounts") return respond(...(options.accounts ?? [200, ACCOUNTS]));
      if (url.pathname === "/api/transactions") {
        return respond(200, {
          period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
          items: [
            { id: "t1", account_id: "acc_1", status: "booked", transaction_date: "2026-11-02", amount_minor: -200_000, counterparty: "", description: "Swish till Exempel", category_id: "mat", is_internal_transfer: false, split: false, hidden: false, known_account_name: "<b>Konto A</b>" },
            { id: "t2", account_id: "acc_1", status: "booked", transaction_date: "2026-11-01", amount_minor: -5_000, counterparty: "Kiosken", description: "", category_id: "mat", is_internal_transfer: false, split: false, hidden: false, known_account_name: null },
          ],
          next_cursor: null,
        });
      }
      if (url.pathname === "/api/transactions/t1") return respond(200, details[Math.min(n++, details.length - 1)]);
      return respond(200, { items: [] });
    }),
  );
  return puts;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function open() {
  window.history.replaceState(null, "", "/transaktioner/t1");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const section = () => screen.getByRole("region", { name: "Känt konto" });

describe("listan (KK-54-B)", () => {
  it("visar Till: <namn> som text på en kopplad överföring och inget på andra", async () => {
    api([detail()]);
    window.history.replaceState(null, "", "/transaktioner");
    await act(async () => {
      render(<App />);
      await Promise.resolve();
    });
    await settle();
    const rows = screen.getAllByRole("listitem").filter((li) => li.className.includes("tx"));
    expect(rows.find((r) => r.textContent.includes("Swish till Exempel"))?.textContent).toContain("Till: <b>Konto A</b>");
    expect(rows.find((r) => r.textContent.includes("Kiosken"))?.textContent).not.toContain("Till:");
  });
});

describe("det kända kontot på en transaktion (KK-54-B, KK-54-C)", () => {
  it("visar Till: <namn> som text och kopplar loss för hand", async () => {
    const puts = api([detail({ known_account: { id: "k1", name: "<b>Konto A</b>", source: "auto" } }), detail()]);
    await open();
    expect(screen.getByText("Till: <b>Konto A</b> (automatiskt)").tagName).toBe("DD");
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla loss från kontot" }));
    await settle();
    expect(puts).toEqual([{ path: "/api/transactions/t1/known-account", body: { known_account_id: null } }]);
    expect(screen.getByRole("status").textContent).toBe("Överföringen är kopplad loss från kontot.");
    expect(within(section()).getByRole("button", { name: "Koppla till känt konto" })).toBeTruthy();
  });

  it("kopplar en överföring till ett valt konto, och kan avbryta valet", async () => {
    const puts = api([detail(), detail({ known_account: { id: "k2", name: "Barnspar", source: "manual" } })]);
    await open();
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla till känt konto" }));
    await settle();
    expect(within(section()).getAllByRole("option").map((o) => o.textContent)).toEqual(["<b>Konto A</b>", "Barnspar"]);
    fireEvent.click(within(section()).getByRole("button", { name: "Avbryt" }));
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla till känt konto" }));
    await settle();
    fireEvent.change(within(section()).getByLabelText("Känt konto"), { target: { value: "k2" } });
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla" }));
    await settle();
    expect(puts).toEqual([{ path: "/api/transactions/t1/known-account", body: { known_account_id: "k2" } }]);
    expect(screen.getByRole("status").textContent).toBe("Överföringen är kopplad till kontot.");
    expect(screen.getByText("Till: Barnspar (vald av dig)")).toBeTruthy();
  });

  it("kan lägga till överföringens text som matchningstext", async () => {
    const puts = api([detail(), detail()]);
    await open();
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla till känt konto" }));
    await settle();
    fireEvent.click(within(section()).getByRole("checkbox"));
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla" }));
    await settle();
    expect(puts).toEqual([{ path: "/api/transactions/t1/known-account", body: { known_account_id: "k1", add_pattern: true } }]);
  });

  it("säger till utan konton, när kontona inte går att hämta och när kopplingen inte går att spara", async () => {
    api([detail()], { accounts: [200, { known_accounts: [] }] });
    await open();
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla till känt konto" }));
    await settle();
    expect(section().textContent).toContain("Lägg till kontot under Inställningar › Kända konton först.");
    cleanup();
    api([detail()], { accounts: [503, {}] });
    await open();
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla till känt konto" }));
    await settle();
    expect(within(section()).getByRole("alert").textContent).toBe("Det gick inte att hämta kontona. Försök igen.");
    cleanup();
    api([detail({ known_account: { id: "k1", name: "Konto A", source: "manual" } })], { put: 503 });
    await open();
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla loss från kontot" }));
    await settle();
    expect(within(section()).getByRole("alert").textContent).toBe("Det gick inte att spara kopplingen. Försök igen.");
  });

  it("svar med fel form blir ingen koppling", () => {
    expect(toLinkedKnownAccount({ id: "k1" })).toBeNull();
    expect(toLinkedKnownAccount(null)).toBeNull();
    expect(knownAccountLabel({ id: "k1", name: "Konto A", source: "manual" })).toBe("Konto A (vald av dig)");
    expect(knownAccountLabel({ id: "k1", name: "Konto A", source: "auto" })).toBe("Konto A (automatiskt)");
  });
});
