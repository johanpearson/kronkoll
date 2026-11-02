// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { applyStoredTheme, THEME_KEY } from "./theme.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  window.history.replaceState(null, "", "/");
});

function at(path: string) {
  window.history.replaceState(null, "", path);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
  render(<App />);
}

describe("välja ljust, mörkt eller system (KK-26-A)", () => {
  it("följer systemet tills användaren väljer något annat", () => {
    at("/installningar");
    const group = screen.getByRole("radiogroup", { name: "Utseende" });
    expect(within(group).getAllByRole("radio").map((r) => r.closest("label")?.textContent)).toEqual(["Som systemet", "Ljust", "Mörkt"]);
    expect(within(group).getByRole<HTMLInputElement>("radio", { name: "Som systemet" }).checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("ett val gäller direkt och sparas på enheten", () => {
    at("/installningar");
    fireEvent.click(screen.getByRole("radio", { name: "Mörkt" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "Som systemet" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("vid start används det sparade valet, och ett okänt värde ignoreras", () => {
    window.localStorage.setItem(THEME_KEY, "light");
    applyStoredTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    window.localStorage.setItem(THEME_KEY, "lila");
    delete document.documentElement.dataset.theme;
    applyStoredTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("fungerar även när webbläsaren nekar lagring", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("nekad");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("nekad");
    });
    expect(() => {
      applyStoredTheme();
    }).not.toThrow();
    at("/installningar");
    fireEvent.click(screen.getByRole("radio", { name: "Ljust" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("flikraden har ikoner (KK-26)", () => {
  it("varje flik har en ikon som skärmläsare hoppar över, så att namnen är oförändrade", () => {
    at("/");
    const links = within(screen.getByRole("navigation", { name: "Huvudmeny" })).getAllByRole("link");
    for (const link of links) expect(link.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(links.map((l) => l.textContent)).toEqual(["Översikt", "Transaktioner", "Budget", "Inställningar"]);
  });
});

describe("transaktionsraden (KK-4)", () => {
  it("märker inkomster så att de syns i grönt, och utgifter inte", async () => {
    const page = {
      period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
      items: [
        { id: "in", status: "booked", transaction_date: "2026-11-02", amount_minor: 2500000, counterparty: "ARBETSGIVAREN AB", description: "", category_id: null, is_internal_transfer: false, split: false },
        { id: "ut", status: "booked", transaction_date: "2026-11-02", amount_minor: -4500, counterparty: "ESPRESSO HOUSE", description: "", category_id: null, is_internal_transfer: false, split: false },
      ],
      next_cursor: null,
    };
    window.history.replaceState(null, "", "/transaktioner");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(page), { status: 200 }))));
    await act(async () => {
      render(<App />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const amount = (name: string) => screen.getByText(name).closest("li")?.querySelector(".amount");
    expect(amount("ARBETSGIVAREN AB")?.classList.contains("income")).toBe(true);
    expect(amount("ESPRESSO HOUSE")?.classList.contains("income")).toBe(false);
  });
});
