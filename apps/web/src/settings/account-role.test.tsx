// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

// Påhittade konton (KK-13) i API:ts form. Det fjärde har en okänd roll och visas som Inkomst/Utgift.
const ACCOUNTS = {
  items: [
    { id: "acc_1", name: "Gemensamt", nickname: "Gemensamt", bank_name: "Privatkonto ••4821", bank: "Skandia", type: "checking", role: "spending" },
    { id: "acc_2", name: "Buffert", nickname: "Buffert", bank_name: "Sparkonto ••7712", bank: "Skandia", type: "savings", role: "buffer" },
    { id: "acc_3", name: "Privat", nickname: null, bank_name: "Privat", bank: null, type: "checking", role: "excluded" },
    { id: "acc_4", name: "Nytt", nickname: null, bank_name: "Nytt", bank: null, type: "checking", role: "okänd" },
  ],
};

type Patch = { path: string; body: unknown; csrf: string | null };

function api(patch: (body: unknown) => [number, unknown] = (body) => [200, { id: "acc_1", ...(body as object) }]) {
  const patches: Patch[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (init?.method === "PATCH") {
        const body: unknown = JSON.parse(typeof init.body === "string" ? init.body : "null");
        patches.push({ path: url.pathname, body, csrf: new Headers(init.headers).get("x-kronkoll") });
        return json(...patch(body));
      }
      if (url.pathname === "/api/accounts") return json(200, ACCOUNTS);
      if (url.pathname === "/api/connections") return json(200, { items: [] });
      if (url.pathname === "/api/settings") return json(200, { budget_period_start_day: 1, current_period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" } });
      return json(404, { error: "not_found" });
    }),
  );
  return patches;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function open() {
  window.history.replaceState(null, "", "/installningar");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const role = (name: string) => screen.getByRole("radiogroup", { name: `Roll för ${name}` });
const checked = (name: string) => within(role(name)).getByRole("radio", { checked: true }).textContent;
const rows = () => within(screen.getByRole("list", { name: "Konton" })).getAllByRole("listitem");

const EXPLAINED = {
  spending: "Lön och utgifter. Överföringar mellan sådana konton räknas inte.",
  buffer: "Sparande. Överföringar hit räknas som sparande och uttag härifrån som uttag från sparande.",
  excluded: "Syns inte någonstans. Överföringar dit räknas som utgifter och överföringar därifrån som inkomster.",
};

describe("roll per konto i Inställningar (KK-53-A)", () => {
  it("visar varje kontos roll med en förklaring, och en okänd roll som Inkomst/Utgift", async () => {
    api();
    await open();
    expect([checked("Gemensamt"), checked("Buffert"), checked("Privat"), checked("Nytt")]).toEqual(["Inkomst/Utgift", "Buffert", "Uteslutet", "Inkomst/Utgift"]);
    expect(within(rows()[0] as HTMLElement).getByText(EXPLAINED.spending)).toBeTruthy();
    expect(within(rows()[1] as HTMLElement).getByText(EXPLAINED.buffer)).toBeTruthy();
    expect(within(rows()[2] as HTMLElement).getByText(EXPLAINED.excluded)).toBeTruthy();
  });

  it("sparar rollen med CSRF-skydd och visar den när servern har svarat", async () => {
    const patches = api((body) => [200, { id: "acc_1", name: "Gemensamt", nickname: "Gemensamt", ...(body as object) }]);
    await open();
    fireEvent.click(within(role("Gemensamt")).getByRole("radio", { name: "Buffert" }));
    await settle();
    expect(patches).toEqual([{ path: "/api/accounts/acc_1", body: { role: "buffer" }, csrf: "1" }]);
    expect(checked("Gemensamt")).toBe("Buffert");
    expect(within(rows()[0] as HTMLElement).getByText(EXPLAINED.buffer)).toBeTruthy();
    fireEvent.click(within(role("Privat")).getByRole("radio", { name: "Inkomst/Utgift" }));
    await settle();
    expect(patches[1]).toMatchObject({ path: "/api/accounts/acc_3", body: { role: "spending" } });
    expect(checked("Privat")).toBe("Inkomst/Utgift");
  });

  it("ändrar inget och visar ett fel när sparandet misslyckas", async () => {
    api(() => [503, { error: "unavailable" }]);
    await open();
    fireEvent.click(within(role("Gemensamt")).getByRole("radio", { name: "Uteslutet" }));
    await settle();
    expect(checked("Gemensamt")).toBe("Inkomst/Utgift");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara. Försök igen.");
  });
});
