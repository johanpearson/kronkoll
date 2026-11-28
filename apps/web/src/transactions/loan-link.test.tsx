// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { loanLabel, toLinkedLoan } from "./LoanLink.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittad lånebetalning (KK-13) i API:ts form. */
function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    account: { id: "acc_1", name: "Privatkonto ••7466", type: "checking" },
    status: "booked",
    transaction_date: "2026-11-02",
    booking_date: "2026-11-02",
    amount_minor: -550_000,
    counterparty: "",
    counterparty_norm: "",
    description: "Betalning 9020 1234567",
    category_id: null,
    category_source: "none",
    is_internal_transfer: false,
    manual_transfer: null,
    transfer_pair: null,
    splits: [],
    loan: null,
    ...overrides,
  };
}

const LOANS = { loans: [{ id: "l1", name: "<b>Bolån</b>" }, { id: "l2", name: "Billån" }] };

function api(details: Record<string, unknown>[], options: { loans?: [number, unknown]; put?: number } = {}) {
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
      if (url.pathname === "/api/loans") return respond(...(options.loans ?? [200, LOANS]));
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

const section = () => screen.getByRole("region", { name: "Lån" });

describe("lånet på en transaktion (KK-59-B)", () => {
  it("visar Lån: <namn> som text och kopplar loss för hand", async () => {
    const puts = api([detail({ loan: { id: "l1", name: "<b>Bolån</b>", source: "auto" } }), detail()]);
    await open();
    expect(screen.getByText("<b>Bolån</b> (automatiskt)").tagName).toBe("DD");
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla loss från lånet" }));
    await settle();
    expect(puts).toEqual([{ path: "/api/transactions/t1/loan", body: { loan_id: null } }]);
    expect(screen.getByRole("status").textContent).toBe("Betalningen är kopplad loss från lånet.");
    expect(within(section()).getByRole("button", { name: "Koppla till lån" })).toBeTruthy();
  });

  it("kopplar en betalning till ett valt lån, och kan avbryta valet", async () => {
    const puts = api([detail(), detail({ loan: { id: "l2", name: "Billån", source: "manual" } })]);
    await open();
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla till lån" }));
    await settle();
    expect(within(section()).getAllByRole("option").map((o) => o.textContent)).toEqual(["<b>Bolån</b>", "Billån"]);
    fireEvent.click(within(section()).getByRole("button", { name: "Avbryt" }));
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla till lån" }));
    await settle();
    fireEvent.change(within(section()).getByLabelText("Lån"), { target: { value: "l2" } });
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla" }));
    await settle();
    expect(puts).toEqual([{ path: "/api/transactions/t1/loan", body: { loan_id: "l2" } }]);
    expect(screen.getByRole("status").textContent).toBe("Betalningen är kopplad till lånet.");
    expect(screen.getByText("Billån (vald av dig)")).toBeTruthy();
  });

  it("säger till utan lån, när lånen inte går att hämta och när kopplingen inte går att spara", async () => {
    api([detail()], { loans: [200, { loans: [] }] });
    await open();
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla till lån" }));
    await settle();
    expect(section().textContent).toContain("Lägg till lånet under Lån först.");
    cleanup();
    api([detail()], { loans: [503, {}] });
    await open();
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla till lån" }));
    await settle();
    expect(within(section()).getByRole("alert").textContent).toBe("Det gick inte att hämta lånen. Försök igen.");
    cleanup();
    api([detail({ loan: { id: "l1", name: "Bolån", source: "manual" } })], { put: 503 });
    await open();
    fireEvent.click(within(section()).getByRole("button", { name: "Koppla loss från lånet" }));
    await settle();
    expect(within(section()).getByRole("alert").textContent).toBe("Det gick inte att spara kopplingen. Försök igen.");
  });

  it("en insättning utan koppling har inga knappar för lån, och svar med fel form blir ingen koppling", async () => {
    api([detail({ amount_minor: 500 })]);
    await open();
    expect(screen.queryByRole("region", { name: "Lån" })).toBeNull();
    expect(toLinkedLoan({ id: "l1" })).toBeNull();
    expect(toLinkedLoan(null)).toBeNull();
    expect(loanLabel({ id: "l1", name: "Bolån", source: "manual" })).toBe("Bolån (vald av dig)");
  });
});
