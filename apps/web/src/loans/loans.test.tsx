// @vitest-environment jsdom
import { formatSek } from "@kronkoll/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { formatRate, toLoan } from "./loan.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittade lån i samma form som GET /api/loans (KK-13). */
const BOLAN = {
  id: "l1", name: "Bolån del 1", lender: "Exempelbanken", balance_minor: 120_000_000, interest_rate_bp: 350, rate_fixed_until: "2026-12-15", amortization_minor: 200_000,
  monthly_interest_minor: 350_000, monthly_amortization_minor: 200_000, monthly_cost_minor: 550_000, rate_fixed: true, rate_fixed_days_left: 41, rate_fixed_ending: true,
  match_patterns: ["9020-12 345 67"], category_id: "boende-laneranta", paid: { paid_minor: 550_000, last_paid_on: "2026-11-02", missing: false },
};
const BIL = {
  id: "l2", name: "Billån", lender: null, balance_minor: 8_600_000, interest_rate_bp: 695, rate_fixed_until: null, amortization_minor: 245_000,
  monthly_interest_minor: 49_808, monthly_amortization_minor: 245_000, monthly_cost_minor: 294_808, rate_fixed: false, rate_fixed_days_left: null, rate_fixed_ending: false,
  match_patterns: [], category_id: null, paid: { paid_minor: 0, last_paid_on: null, missing: false },
};
const LIST = { loans: [BOLAN, BIL], total_balance_minor: 128_600_000, total_monthly_interest_minor: 399_808, total_monthly_amortization_minor: 445_000, total_monthly_cost_minor: 844_808 };

/** Påhittade träffar i förhandsvisningen, med bankens text som den kom (KK-30). */
const PREVIEW = {
  count: 4,
  examples: [
    { id: "t1", date: "2026-11-02", amount_minor: -550_000, counterparty: "", description: "<b>Betalning</b> 9020 1234567" },
    { id: "t2", date: "2026-10-02", amount_minor: -550_000, counterparty: "EXEMPELBANKEN", description: "" },
  ],
};

function api(list: [number, unknown] = [200, LIST], write: number = 201, preview: [number, unknown] = [200, PREVIEW], matching = 200) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));
      if (init?.method === "PUT" || init?.method === "DELETE" || init?.method === "POST") {
        writes.push({ method: init.method, path: url.pathname, body: init.body ? (JSON.parse(init.body as string) as unknown) : null });
        if (url.pathname === "/api/loans/preview") return json(...preview);
        if (url.pathname.endsWith("/matching")) return json(matching, { linked: 3 });
        return json(write, {});
      }
      if (url.pathname === "/api/loans") return json(...list);
      return json(200, { items: [] });
    }),
  );
  return writes;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function open(path = "/lan") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

/** Lånen, utan diagrammens dolda värdelistor. */
const rows = () => [...screen.getByRole("list", { name: "Dina lån" }).querySelectorAll<HTMLElement>(":scope > li")];
const type = (scope: HTMLElement, label: string, value: string) => {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
};

describe("Lån (#72, KK-36)", () => {
  it("visar totalsummor och varje lån (KK-36-C)", async () => {
    api();
    await open();
    expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual([formatSek(128_600_000), formatSek(844_808)]);
    expect(rows()[0]?.querySelector("h2")?.textContent).toBe("Bolån del 1");
    expect(rows()[0]?.textContent).toContain(`Exempelbanken${formatSek(550_000)}/mån`);
    expect(rows()[0]?.textContent).toContain(`Skuld ${formatSek(120_000_000)} · 3,50 % · ränta ${formatSek(350_000)} + amortering ${formatSek(200_000)}`);
    expect(rows()[1]?.textContent).toContain("Billån");
    expect(rows()[1]?.textContent).not.toContain("Exempelbanken");
    expect(screen.getByRole("note").textContent).toBe(
      `Varje månad: ${formatSek(399_808)} ränta och ${formatSek(445_000)} amortering. Lånebetalningarna räknas hela som boendekostnad i budgeten.`,
    );
  });

  it("markerar bindningstid som slutar inom 60 dagar med färg och text, men inte rörlig ränta", async () => {
    api([200, { ...LIST, loans: [BOLAN, BIL, { ...BOLAN, id: "l3", name: "Del 2", rate_fixed_days_left: 0 }, { ...BOLAN, id: "l4", name: "Del 3", rate_fixed_days_left: 400, rate_fixed_ending: false }] }]);
    await open();
    const [del1, bil, del2, del3] = rows();
    expect(del1?.querySelector(".ui-chip")?.textContent).toBe("Bindningstiden slutar om 41 dagar");
    expect(del1?.querySelector(".ui-chip")?.className).toBe("ui-chip ui-chip-warning");
    expect(del2?.querySelector(".ui-chip")?.textContent).toBe("Bindningstiden slutar i dag");
    expect(bil?.querySelector(".ui-chip")).toBeNull();
    expect(bil?.textContent).toContain("Rörlig ränta");
    expect(del3?.textContent).toContain("Bunden ränta i 400 dagar till");
  });

  it("lägger till ett lån och visar det efter att det sparats", async () => {
    const writes = api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Lägg till lån" }));
    const form = screen.getByRole("form", { name: "Nytt lån" });
    type(form, "Namn", "Bolån del 2");
    type(form, "Långivare (valfritt)", " ");
    type(form, "Skuld (kr)", "1 200 000");
    type(form, "Ränta (%)", "3,85");
    type(form, "Bunden till (tomt för rörlig ränta)", "2028-03-31");
    type(form, "Amortering (kr/mån)", "2 000");
    fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("PUT");
    expect(writes[0]?.path).toMatch(/^\/api\/loans\/[0-9a-f-]{36}$/u);
    expect(writes[0]?.body).toEqual({ name: "Bolån del 2", lender: null, balance_minor: 120_000_000, interest_rate_bp: 385, rate_fixed_until: "2028-03-31", amortization_minor: 200_000 });
    expect(screen.getByRole("status").textContent).toBe("Lånet är sparat.");
    expect(screen.queryByRole("form", { name: "Nytt lån" })).toBeNull();
  });

  it("ändrar ett lån med sina värden ifyllda, och tar bort ett", async () => {
    const writes = api(undefined, 200);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Bolån del 1" }));
    const form = screen.getByRole("form", { name: "Ändra Bolån del 1" });
    expect(within(form).getByLabelText<HTMLInputElement>("Skuld (kr)").value).toBe("1200000");
    expect(within(form).getByLabelText<HTMLInputElement>("Ränta (%)").value).toBe("3,5");
    type(form, "Skuld (kr)", "1 198 000,50");
    fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    await settle();
    expect(writes[0]).toEqual({ method: "PUT", path: "/api/loans/l1", body: expect.objectContaining({ balance_minor: 119_800_050, lender: "Exempelbanken", interest_rate_bp: 350 }) as unknown });
    expect(screen.getByRole("status").textContent).toBe("Lånet är ändrat.");
    cleanup();
    const deletes = api(undefined, 204);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Billån" }));
    fireEvent.click(screen.getByRole("button", { name: "Ta bort" }));
    expect(screen.getByRole("form", { name: "Ändra Billån" }).textContent).toContain("Ta bort lånet? Det försvinner ur lånöversikten och betalningarna kopplas loss. Inget hos banken ändras.");
    fireEvent.click(screen.getByRole("button", { name: "Behåll" }));
    expect(screen.queryByRole("button", { name: "Behåll" })).toBeNull();
    expect(deletes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Ta bort" }));
    fireEvent.click(screen.getByRole("button", { name: "Ta bort" }));
    await settle();
    expect(deletes).toEqual([{ method: "DELETE", path: "/api/loans/l2", body: null }]);
    expect(screen.getByRole("status").textContent).toBe("Lånet är borttaget.");
  });

  it("säger vad som saknas innan något skickas, och när API:t säger nej", async () => {
    const writes = api(undefined, 503);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Lägg till lån" }));
    const form = screen.getByRole("form", { name: "Nytt lån" });
    const submit = async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
      await settle();
      return within(form).getByRole("alert").textContent;
    };
    expect(await submit()).toBe("Ge lånet ett namn, till exempel Bolån del 1.");
    type(form, "Namn", "Lån");
    expect(await submit()).toBe("Skriv skulden i kronor, till exempel 1 200 000.");
    type(form, "Skuld (kr)", "100 000");
    expect(await submit()).toBe("Skriv räntan i procent, till exempel 3,5.");
    type(form, "Ränta (%)", "4");
    type(form, "Amortering (kr/mån)", "-1");
    expect(await submit()).toBe("Skriv amorteringen i kronor per månad, eller 0.");
    expect(writes).toEqual([]);
    type(form, "Amortering (kr/mån)", "");
    expect(await submit()).toBe("Det gick inte att spara lånet. Försök igen.");
    fireEvent.click(within(form).getByRole("button", { name: "Avbryt" }));
    expect(screen.queryByRole("form", { name: "Nytt lån" })).toBeNull();
  });

  it("utan lån visas en uppmaning, och fel vid hämtning och borttagning syns", async () => {
    api([200, { loans: [], total_balance_minor: 0 }]);
    await open();
    expect(screen.getByRole("heading", { name: "Inga lån än" })).toBeTruthy();
    expect(screen.getByRole("main").textContent).toContain("Ett bolån i flera delar läggs in som ett lån per del.");
    cleanup();
    api([503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta lånen. Försök igen om en stund.");
    cleanup();
    api(undefined, 503);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Billån" }));
    fireEvent.click(screen.getByRole("button", { name: "Ta bort" }));
    fireEvent.click(screen.getByRole("button", { name: "Ta bort" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att ta bort lånet. Försök igen.");
  });

  it("visar Betalt denna period, en varning när inget har kommit och ett diagram över ränta och amortering (KK-59-C)", async () => {
    const tom = { ...BOLAN, id: "l3", name: "Del 2", paid: { paid_minor: 0, last_paid_on: null, missing: false } };
    const saknas = { ...BOLAN, id: "l4", name: "Del 3", paid: { paid_minor: 0, last_paid_on: null, missing: true } };
    api([200, { ...LIST, loans: [BOLAN, BIL, tom, saknas] }]);
    await open();
    const [del1, bil, del2, del3] = rows();
    expect(del1?.querySelector(".loan-paid")?.textContent).toBe(`Betalt denna period: ${formatSek(550_000)} av ${formatSek(550_000)}, senast 2 nov. 2026`);
    // Utan kontouppgifter sägs inget om perioden. Med kontouppgifter men utan betalning står det i text.
    expect(bil?.textContent).not.toContain("denna period");
    expect(del2?.textContent).toContain("Ingen betalning än denna period");
    expect(del3?.querySelector(".ui-chip-danger")?.textContent).toBe("Ingen betalning har kommit denna period");
    const chart = within(del1 as HTMLElement).getByRole("img", { name: "Månadskostnaden för Bolån del 1" });
    expect(chart.querySelectorAll("rect")).toHaveLength(2);
    expect(within(del1 as HTMLElement).getByRole("list", { name: "Månadskostnaden för Bolån del 1" }).textContent).toContain(`Ränta: ${formatSek(350_000)}`);
  });

  it("förhandsvisar kontouppgifterna och sparar dem efter lånet, som kopplar om historiken (KK-59-A)", async () => {
    const writes = api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Lägg till lån" }));
    const form = screen.getByRole("form", { name: "Nytt lån" });
    expect(within(form).getByRole<HTMLButtonElement>("button", { name: "Visa träffar" }).disabled).toBe(true);
    type(form, "Kontouppgifter (valfritt)", " 9020-12 345 67 \n\nEXEMPELBANKEN");
    fireEvent.click(within(form).getByRole("button", { name: "Visa träffar" }));
    await settle();
    expect(writes.at(-1)).toEqual({ method: "POST", path: "/api/loans/preview", body: { match_patterns: ["9020-12 345 67", "EXEMPELBANKEN"] } });
    const preview = within(form).getByRole("status");
    expect(preview.textContent).toContain("4 betalningar träffar.");
    // Bankens text visas som text, även när den ser ut som HTML.
    expect(within(preview).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      `2 nov. 2026 · ${formatSek(-550_000)} · <b>Betalning</b> 9020 1234567`,
      `2 okt. 2026 · ${formatSek(-550_000)} · EXEMPELBANKEN`,
    ]);
    // En ändrad text tar bort förhandsvisningen, som inte längre stämmer.
    type(form, "Kontouppgifter (valfritt)", "9020-12 345 67");
    expect(within(form).queryByRole("status")).toBeNull();
    type(form, "Namn", "Bolån del 2");
    type(form, "Skuld (kr)", "1 000 000");
    type(form, "Ränta (%)", "4");
    fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    await settle();
    const [, put, matching] = writes;
    expect(matching).toEqual({ method: "PUT", path: `${String(put?.path)}/matching`, body: { match_patterns: ["9020-12 345 67"] } });
    expect(screen.getByRole("status").textContent).toBe("Lånet är sparat. 3 betalningar kopplades om.");
  });

  it("sparar inte kontouppgifterna när de är oförändrade, och behåller lånets kategori när de ändras", async () => {
    const writes = api(undefined, 200);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Bolån del 1" }));
    let form = screen.getByRole("form", { name: "Ändra Bolån del 1" });
    expect(within(form).getByLabelText<HTMLTextAreaElement>("Kontouppgifter (valfritt)").value).toBe("9020-12 345 67");
    fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    await settle();
    expect(writes.map((w) => w.path)).toEqual(["/api/loans/l1"]);
    fireEvent.click(screen.getByRole("button", { name: "Ändra Bolån del 1" }));
    form = screen.getByRole("form", { name: "Ändra Bolån del 1" });
    type(form, "Kontouppgifter (valfritt)", "");
    fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    await settle();
    expect(writes.at(-1)).toEqual({ method: "PUT", path: "/api/loans/l1/matching", body: { match_patterns: [], category_id: "boende-laneranta" } });
  });

  it("säger till när förhandsvisningen eller kontouppgifterna inte går att spara, och när de är för många", async () => {
    api(undefined, 201, [503, {}], 503);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Lägg till lån" }));
    const form = screen.getByRole("form", { name: "Nytt lån" });
    type(form, "Kontouppgifter (valfritt)", Array.from({ length: 11 }, (_, i) => `konto ${String(i)}`).join("\n"));
    fireEvent.click(within(form).getByRole("button", { name: "Visa träffar" }));
    await settle();
    expect(within(form).getByRole("alert").textContent).toBe("Skriv högst tio kontouppgifter, var och en på högst 60 tecken.");
    type(form, "Kontouppgifter (valfritt)", "9020-12 345 67");
    fireEvent.click(within(form).getByRole("button", { name: "Visa träffar" }));
    await settle();
    expect(within(form).getByRole("alert").textContent).toBe("Det gick inte att visa träffarna. Försök igen.");
    type(form, "Namn", "Lån");
    type(form, "Skuld (kr)", "1 000");
    type(form, "Ränta (%)", "4");
    fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    await settle();
    expect(within(form).getByRole("alert").textContent).toBe("Lånet är sparat, men inte kontouppgifterna. Försök igen.");
  });

  it("tål svar med saknade fält och visar räntan med två decimaler", () => {
    expect(toLoan({ name: "x" })).toBeNull();
    expect(toLoan({ id: "x", name: "Lån" })).toMatchObject({ lender: null, balanceMinor: 0, daysLeft: null, ending: false, rateFixed: false, matchPatterns: [], categoryId: null, paid: { paidMinor: 0, lastPaidOn: null, missing: false } });
    expect(toLoan({ id: "x", name: "Lån", match_patterns: ["ok", 5], paid: { paid_minor: 1.5, missing: true } })).toMatchObject({ matchPatterns: ["ok"], paid: { paidMinor: 0, missing: true } });
    expect(formatRate(695)).toBe("6,95 %");
    expect(formatRate(0)).toBe("0,00 %");
  });
});
