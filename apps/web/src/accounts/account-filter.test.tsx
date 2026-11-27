// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { accountParams } from "./account-filter.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const PERIOD = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };

// Påhittade konton (KK-13): det tredje och fjärde är uteslutna och ska inte kunna väljas. Det fjärde
// säger det bara med rollen (KK-53), som gäller före det gamla fältet.
const ACCOUNTS = [
  { id: "acc_1", name: "Gemensamt", nickname: "Gemensamt", bank_name: "Privatkonto ••4821", bank: "Skandia", type: "checking", counted: true },
  { id: "acc_2", name: "Privat", nickname: "Privat", bank_name: "Privatkonto ••5310", bank: "Skandia", type: "checking", counted: true },
  { id: "acc_3", name: "Privat sparande", nickname: "Privat sparande", bank_name: "Sparkonto ••7712", bank: "Skandia", type: "savings", counted: false },
  { id: "acc_4", name: "Utesluten", nickname: "Utesluten", bank_name: "Privatkonto ••9001", bank: "Skandia", type: "checking", role: "excluded", counted: true },
];

/** Svarar med tomma men giltiga vyer och minns vilka adresser som hämtades. */
function api(accounts: unknown[] = ACCOUNTS) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      urls.push(url.pathname + url.search);
      if (url.pathname === "/api/accounts") return json(200, { items: accounts });
      if (url.pathname === "/api/transactions") return json(200, { period: PERIOD, items: [], next_cursor: null });
      if (url.pathname.startsWith("/api/budgets/")) return json(200, { period: PERIOD, lines: [], groups: [] });
      if (url.pathname === "/api/insights") return json(200, { period: PERIOD });
      return json(404, { error: "not_found" });
    }),
  );
  return urls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function open(path: string) {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const chip = (name: string) => screen.getByRole("button", { name });
const last = (urls: string[], prefix: string) => urls.filter((u) => u.startsWith(prefix)).at(-1);

describe("accountParams", () => {
  it("ger tomt utan konton och en parameter per konto med kodade id", () => {
    expect(accountParams([])).toBe("");
    expect(accountParams(["acc_1", "a b&c"])).toBe("account=acc_1&account=a%20b%26c");
  });
});

describe.each([
  ["Transaktioner", "/transaktioner", "/api/transactions"],
  ["Budget", "/budget", "/api/budgets/current"],
  ["Insikter", "/insikter", "/api/insights"],
])("kontofilter i %s (KK-41-C)", (_, path, endpoint) => {
  it("visar bara konton som räknas med, och ingen text så länge inget är valt", async () => {
    const urls = api();
    await open(path);
    expect(screen.getByRole("group", { name: "Konton" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Privat sparande" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Utesluten" })).toBeNull();
    expect(chip("Gemensamt").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("note")?.textContent ?? "").not.toContain("Visar bara");
    expect(last(urls, endpoint)).toBe(endpoint);
  });

  it("hämtar om med valda konton, visar vilka i text och går tillbaka till alla", async () => {
    const urls = api();
    await open(path);
    fireEvent.click(chip("Gemensamt"));
    await settle();
    expect(chip("Gemensamt").getAttribute("aria-pressed")).toBe("true");
    expect(last(urls, endpoint)).toContain("account=acc_1");
    expect(screen.getByText("Visar bara Gemensamt")).toBeTruthy();
    fireEvent.click(chip("Privat"));
    await settle();
    expect(last(urls, endpoint)).toContain("account=acc_1&account=acc_2");
    expect(screen.getByText("Visar bara Gemensamt och Privat")).toBeTruthy();
    fireEvent.click(chip("Gemensamt"));
    await settle();
    expect(last(urls, endpoint)).not.toContain("acc_1");
    fireEvent.click(screen.getByRole("button", { name: "Visa alla konton" }));
    await settle();
    expect(last(urls, endpoint)).not.toContain("account=");
    expect(screen.queryByText(/Visar bara/u)).toBeNull();
  });

  it("döljs när färre än två konton räknas med, eftersom det inte finns något att välja", async () => {
    api([ACCOUNTS[0]]);
    await open(path);
    expect(screen.queryByRole("group", { name: "Konton" })).toBeNull();
  });
});
