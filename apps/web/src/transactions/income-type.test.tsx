// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { incomeLabel } from "./IncomeType.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittade transaktioner i samma form som GET /api/transactions/{id} (KK-13). */
const tx = (extra: Record<string, unknown>) => ({
  id: "t1", account: { id: "acc_1", name: "Vardag", type: "checking" }, status: "booked", transaction_date: "2026-11-25", booking_date: "2026-11-25",
  amount_minor: 3361000, counterparty: "", counterparty_norm: "EXEMPEL AB", description: "EXEMPEL AB LÖN", category_id: null, category_source: "none",
  is_internal_transfer: false, manual_transfer: null, income_type: "other", income_source: "template", transfer_pair: null, splits: [], ...extra,
});

function api(detail: Record<string, unknown>, patch: [number, unknown] = [200, { transaction: { id: "t1", income_type: "salary", income_source: "manual" }, rule: null, updated: 4 }]) {
  let current = detail;
  const patches: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(init.body as string) as unknown);
        if (patch[0] === 200) current = { ...current, income_type: "salary", income_source: "manual" };
        return json(...patch);
      }
      if (url.pathname === "/api/categories") return json(200, { items: [] });
      return json(200, current);
    }),
  );
  return patches;
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

const fact = (term: string) => screen.getAllByRole("term").find((t) => t.textContent === term)?.nextElementSibling?.textContent;

describe("inkomsttyp på transaktionens sida (#40, KK-22-A)", () => {
  it("visar typen och ändrar den med ett tryck, som sparas och lär en regel", async () => {
    const patches = api(tx({}));
    await open();
    expect(fact("Inkomsttyp")).toBe("Övrigt (mall)");
    expect(screen.getByLabelText<HTMLInputElement>("Övrigt").checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Lön"));
    await settle();
    expect(patches).toEqual([{ income_type: "salary" }]);
    expect(screen.getByRole("status").textContent).toBe("Inkomsttypen är sparad. 4 tidigare inbetalningar fick samma typ.");
    expect(fact("Inkomsttyp")).toBe("Lön (vald av dig)");
  });

  it("säger till när det inte går att spara, och valet går tillbaka", async () => {
    api(tx({}), [503, { error: "unavailable" }]);
    await open();
    fireEvent.click(screen.getByLabelText("Föräldrapenning"));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara inkomsttypen. Försök igen.");
    expect(screen.getByLabelText<HTMLInputElement>("Övrigt").checked).toBe(true);
  });

  it("visas inte för utbetalningar eller interna överföringar", async () => {
    for (const extra of [{ amount_minor: -41250, income_type: null }, { is_internal_transfer: true }]) {
      api(tx(extra));
      await open();
      expect(screen.queryByRole("group", { name: "Inkomsttyp" })).toBeNull();
      expect(fact("Inkomsttyp")).toBeUndefined();
      cleanup();
    }
  });

  it("en oklassad inbetalning säger det", () => {
    expect(incomeLabel(null, "none")).toBe("Inte klassad");
    expect(incomeLabel("parental_benefit", "learned")).toBe("Föräldrapenning (inlärd regel)");
    expect(incomeLabel("salary", "okänd")).toBe("Lön (okänd källa)");
  });

  it("utan inkomsttyp från API:t visas inget val markerat", async () => {
    api(tx({ income_type: "bonus", updated: 0 }), [200, { updated: 0 }]);
    await open();
    expect(fact("Inkomsttyp")).toBe("Inte klassad");
    fireEvent.click(screen.getByLabelText("Lön"));
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Inkomsttypen är sparad.");
  });
});
