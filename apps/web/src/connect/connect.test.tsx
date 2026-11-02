// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { browser } from "../browser.ts";

type Call = { url: string; method: string; headers: Headers; body: unknown };
let calls: Call[];

function answer(status: number, body: unknown) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Renderar appen i StrictMode, så att dubbla effekter i utveckling också provas. */
async function at(path: string) {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await Promise.resolve();
  });
}

describe("Koppla bank (#26, F-koppla)", () => {
  it("startsidan leder till Koppla bank", async () => {
    await at("/");
    fireEvent.click(screen.getByRole("link", { name: "Koppla bank" }));
    expect(window.location.pathname).toBe("/koppla");
    expect(screen.getByRole("heading", { level: 1, name: "Koppla bank" })).toBeDefined();
  });

  it("listar bankerna och leder vidare till godkännandet för vald bank", async () => {
    await at("/koppla");
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["Skandia – Konton och kort"]);
    fireEvent.click(screen.getByRole("link", { name: /Skandia/u }));
    expect(window.location.pathname + window.location.search).toBe("/koppla/samtycke?bank=Skandia");
    expect(screen.getByRole("heading", { name: "Kronkoll vill läsa från Skandia" })).toBeDefined();
    expect(screen.getByText("Inga betalningar eller överföringar – kan inte göras")).toBeDefined();
  });

  it.each(["Ond%20Bank", "SBAB"])("en bank som inte finns i listan (%s) leder tillbaka till listan", async (bank) => {
    await at(`/koppla/samtycke?bank=${bank}`);
    expect(screen.getByText("Banken finns inte i listan.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Välj bank" })).toBeDefined();
  });
});

describe("Godkänn läsbehörighet (KK-5-A, KK-29-B)", () => {
  it("startar kopplingen med CSRF-header och skickar användaren till banken", async () => {
    vi.stubGlobal("fetch", answer(200, { redirect_url: "https://tilisy.enablebanking.com/welcome?x=1", state_expires_at: "2026-11-20T10:15:00.000Z", connection_id: "c1" }));
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    await at("/koppla/samtycke?bank=Skandia");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fortsätt till BankID" }));
      await Promise.resolve();
    });
    expect(calls).toEqual([
      expect.objectContaining({ url: "/api/connections", method: "POST", body: { aspsp: { name: "Skandia", country: "SE" } } }),
    ]);
    expect(calls[0]?.headers.get("x-kronkoll")).toBe("1");
    expect(assign).toHaveBeenCalledWith("https://tilisy.enablebanking.com/welcome?x=1");
  });

  it("visar att kopplingen startar medan anropet pågår, och knappen går inte att trycka igen", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    await at("/koppla/samtycke?bank=Skandia");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fortsätt till BankID" }));
      await Promise.resolve();
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Startar…" }).disabled).toBe(true);
  });

  it("följer aldrig en adress som inte är https", async () => {
    vi.stubGlobal("fetch", answer(200, { redirect_url: "javascript:alert(1)", state_expires_at: "x", connection_id: "c1" }));
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    await at("/koppla/samtycke?bank=Skandia");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fortsätt till BankID" }));
      await Promise.resolve();
    });
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att starta kopplingen");
  });

  it("visar ett fel och låter användaren försöka igen när banken inte svarar", async () => {
    vi.stubGlobal("fetch", answer(502, { error: "bank_error" }));
    vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    await at("/koppla/samtycke?bank=Skandia");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fortsätt till BankID" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("Banken svarade inte");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Fortsätt till BankID" }).disabled).toBe(false);
  });
});

describe("Tillbaka från banken: /koppla/klar (KK-29-A, KK-5-C)", () => {
  it("gör kopplingen klar en enda gång, tar bort koden ur adressen och visar att historiken hämtas", async () => {
    vi.stubGlobal("fetch", answer(201, { connection_id: "c1", accounts: 2, initial_sync: "started" }));
    await at("/koppla/klar?code=kod-123&state=abc.def");
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual([expect.objectContaining({ url: "/api/connections/callback", method: "POST", body: { code: "kod-123", state: "abc.def" } })]);
    expect(calls[0]?.headers.get("x-kronkoll")).toBe("1");
    expect(window.location.search).toBe("");
    expect(screen.getByRole("heading", { name: "Kopplat! Hämtar historik…" })).toBeDefined();
    expect(screen.getByText("2 konton hittades.")).toBeDefined();
  });

  it("ett utgånget eller redan använt state ger ett tydligt fel och väg tillbaka", async () => {
    vi.stubGlobal("fetch", answer(400, { error: "invalid_state" }));
    await at("/koppla/klar?code=kod-123&state=abc.def");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("Länken har gått ut eller redan använts");
    expect(screen.getByRole("link", { name: "Försök igen" }).getAttribute("href")).toBe("/koppla");
  });

  it("avbrutet i BankID: inget anrop görs och inget sparas", async () => {
    vi.stubGlobal("fetch", answer(201, {}));
    await at("/koppla/klar?error=access_denied&state=abc.def");
    expect(calls).toEqual([]);
    expect(screen.getByRole("alert").textContent).toBe("Kopplingen avbröts hos banken. Inget sparades.");
  });

  it("utan kod och state görs inget anrop", async () => {
    vi.stubGlobal("fetch", answer(201, {}));
    await at("/koppla/klar");
    expect(calls).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("Kopplingen avbröts hos banken");
  });

  it("ett nätverksfel visas som ett fel, inte som en lyckad koppling", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await at("/koppla/klar?code=kod-123&state=abc.def");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att göra klart kopplingen");
  });
});
