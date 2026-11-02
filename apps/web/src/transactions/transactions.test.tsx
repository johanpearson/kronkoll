// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { shiftPeriodKey } from "./TransactionsView.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittade transaktioner (KK-13) i API:ts form. */
function tx(overrides: Record<string, unknown>) {
  return {
    id: "t1",
    account_id: "acc_1",
    status: "booked",
    transaction_date: "2026-11-01",
    booking_date: "2026-11-01",
    amount_minor: -41250,
    counterparty: "ICA Nära Sofo",
    description: "Kortköp",
    category_id: null,
    category_source: "none",
    is_internal_transfer: false,
    split: false,
    ...overrides,
  };
}

const NOVEMBER = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };

/** Ett API som svarar med sidorna i tur och ordning och minns vilka adresser som anropades. */
function api(pages: unknown[], status = 200) {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      urls.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test"));
      const body = pages[Math.min(urls.length - 1, pages.length - 1)];
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
  return urls;
}

async function at(path: string) {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Transaktioner (#32, KK-4, KK-9, KK-30)", () => {
  it("startsidan leder till transaktionerna", async () => {
    api([{ period: NOVEMBER, items: [], next_cursor: null }]);
    await at("/");
    fireEvent.click(screen.getByRole("link", { name: "Transaktioner" }));
    await settle();
    expect(window.location.pathname).toBe("/transaktioner");
    expect(screen.getByRole("heading", { level: 1, name: "Transaktioner" })).toBeDefined();
  });

  it("visar transaktionerna per dag, nyast först, med svenska belopp och datum", async () => {
    api([
      {
        period: NOVEMBER,
        items: [
          tx({ id: "a", transaction_date: "2026-11-03", amount_minor: 2500000, counterparty: "ARBETSGIVAREN AB" }),
          tx({ id: "b", transaction_date: "2026-11-01" }),
          tx({ id: "c", transaction_date: "2026-11-01", amount_minor: -28600, counterparty: "K*RESTAURANG TAKO" }),
        ],
        next_cursor: null,
      },
    ]);
    await at("/transaktioner");
    const days = screen.getAllByRole("listitem").filter((li) => li.dataset.day !== undefined);
    expect(days.map((d) => d.dataset.day)).toEqual(["2026-11-03", "2026-11-01"]);
    expect(within(days[0] as HTMLElement).getByRole("heading").textContent).toBe(formatDateShort("2026-11-03"));
    expect(screen.getByText("ARBETSGIVAREN AB").closest("li")?.textContent).toContain(formatSek(2500000));
    expect(screen.getByText("ICA Nära Sofo").closest("li")?.textContent).toContain(formatSek(-41250));
    expect(screen.getByText(`Period ${formatDateShort("2026-11-01")} – ${formatDateShort("2026-11-30")}`)).toBeDefined();
  });

  it("märker preliminära, interna överföringar, uppdelade och okategoriserade", async () => {
    api([
      {
        period: NOVEMBER,
        items: [
          tx({ id: "p", status: "pending", booking_date: null, counterparty: "PRELIMINÄR" }),
          tx({ id: "i", is_internal_transfer: true, counterparty: "ÖVERFÖRING" }),
          tx({ id: "s", split: true, category_id: "cat_1", category_source: "manual", counterparty: "UPPDELAD" }),
        ],
        next_cursor: null,
      },
    ]);
    await at("/transaktioner");
    const row = (name: string) => screen.getByText(name).closest("li")?.textContent ?? "";
    expect(row("PRELIMINÄR")).toContain("Preliminär");
    expect(row("ÖVERFÖRING")).toContain("Intern överföring – räknas inte");
    expect(row("UPPDELAD")).toContain("Uppdelad");
    expect(row("PRELIMINÄR")).toContain("Okategoriserad");
    expect(row("UPPDELAD")).not.toContain("Okategoriserad");
  });

  it("visar bankens text som text, aldrig som HTML (KK-30)", async () => {
    api([{ period: NOVEMBER, items: [tx({ counterparty: "<img src=x onerror=alert(1)>", description: "<b>fet</b>" })], next_cursor: null }]);
    await at("/transaktioner");
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeDefined();
    expect(document.querySelector("main img")).toBeNull();
    expect(document.querySelector("main b")).toBeNull();
  });

  it("en transaktion utan motpart visar beskrivningen, och utan båda en neutral text", async () => {
    api([{ period: NOVEMBER, items: [tx({ id: "x", counterparty: "", description: "Swish från mamma" }), tx({ id: "y", counterparty: "", description: "" })], next_cursor: null }]);
    await at("/transaktioner");
    expect(screen.getByText("Swish från mamma")).toBeDefined();
    expect(screen.getByText("Okänd motpart")).toBeDefined();
  });

  it("söker och filtrerar på okategoriserade via API:t, i samma period", async () => {
    const urls = api([{ period: NOVEMBER, items: [tx({})], next_cursor: null }]);
    await at("/transaktioner");
    fireEvent.change(screen.getByRole("searchbox", { name: "Sök" }), { target: { value: "ica" } });
    fireEvent.submit(screen.getByRole("search"));
    await settle();
    fireEvent.click(screen.getByRole("checkbox", { name: "Bara okategoriserade" }));
    await settle();
    const last = urls.at(-1);
    expect(last?.pathname).toBe("/api/transactions");
    expect(last?.searchParams.get("q")).toBe("ica");
    expect(last?.searchParams.get("uncategorized")).toBe("true");
    expect(last?.searchParams.get("period")).toBe("2026-11");
  });

  it("byter till föregående och nästa period", async () => {
    const urls = api([{ period: NOVEMBER, items: [], next_cursor: null }]);
    await at("/transaktioner");
    expect(urls[0]?.searchParams.has("period")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Föregående period" }));
    await settle();
    expect(urls.at(-1)?.searchParams.get("period")).toBe("2026-10");
    fireEvent.click(screen.getByRole("button", { name: "Nästa period" }));
    await settle();
    expect(urls.at(-1)?.searchParams.get("period")).toBe("2026-12");
  });

  it("hämtar fler med cursor och lägger dem sist", async () => {
    const urls = api([
      { period: NOVEMBER, items: [tx({ id: "a", counterparty: "FÖRSTA" })], next_cursor: "c1" },
      { period: NOVEMBER, items: [tx({ id: "b", counterparty: "ANDRA" })], next_cursor: null },
    ]);
    await at("/transaktioner");
    fireEvent.click(screen.getByRole("button", { name: "Visa fler" }));
    await settle();
    expect(urls.at(-1)?.searchParams.get("cursor")).toBe("c1");
    expect(screen.getByText("FÖRSTA")).toBeDefined();
    expect(screen.getByText("ANDRA")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Visa fler" })).toBeNull();
  });

  it("visar ett tomt läge när inget matchar", async () => {
    api([{ period: NOVEMBER, items: [], next_cursor: null }]);
    await at("/transaktioner");
    expect(screen.getByText("Inga transaktioner i perioden.")).toBeDefined();
  });

  it("visar ett fel när API:t inte svarar", async () => {
    api([{ error: "unavailable" }], 503);
    await at("/transaktioner");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta transaktionerna. Försök igen om en stund.");
  });
});

describe("periodnyckel", () => {
  it.each([
    ["2026-11", -1, "2026-10"],
    ["2026-01", -1, "2025-12"],
    ["2026-12", 1, "2027-01"],
  ])("%s %i → %s", (key, months, expected) => {
    expect(shiftPeriodKey(key, months)).toBe(expected);
  });
});
