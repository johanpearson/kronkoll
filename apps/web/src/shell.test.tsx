// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { browser } from "./browser.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

function at(path: string) {
  window.history.replaceState(null, "", path);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
  return render(<App />);
}

const nav = () => screen.getByRole("navigation", { name: "Huvudmeny" });

describe("navigering (#30, KK-25)", () => {
  it("visar huvudmenyn på varje sida och markerar sidan man är på", () => {
    at("/transaktioner");
    const links = within(nav()).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Översikt", "Transaktioner", "Inställningar"]);
    expect(within(nav()).getByRole("link", { name: "Transaktioner" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav()).getByRole("link", { name: "Översikt" }).getAttribute("aria-current")).toBeNull();
  });

  it("byter sida via menyn utan att ladda om", () => {
    at("/");
    fireEvent.click(within(nav()).getByRole("link", { name: "Inställningar" }));
    expect(window.location.pathname).toBe("/installningar");
    expect(screen.getByRole("heading", { level: 1, name: "Inställningar" })).toBeDefined();
  });

  it("menyn finns även på sidor utanför den, som Koppla bank", () => {
    at("/koppla");
    expect(nav()).toBeDefined();
    expect(within(nav()).getByRole("link", { name: "Inställningar" }).getAttribute("aria-current")).toBe("page");
  });

  it("Inställningar leder till Koppla bank", () => {
    at("/installningar");
    fireEvent.click(screen.getByRole("link", { name: "Koppla bank" }));
    expect(window.location.pathname).toBe("/koppla");
  });
});

describe("Logga ut och rensa enheten (KK-35)", () => {
  function fakeStores(options: { failCaches?: boolean } = {}) {
    const deletedCaches: string[] = [];
    const deletedDatabases: string[] = [];
    vi.stubGlobal("caches", {
      keys: () => (options.failCaches ? Promise.reject(new Error("nekad")) : Promise.resolve(["api-v1", "skal-v1"])),
      delete: (name: string) => {
        deletedCaches.push(name);
        return Promise.resolve(true);
      },
    });
    vi.stubGlobal("indexedDB", {
      databases: () => Promise.resolve([{ name: "kronkoll" }, { name: undefined }]),
      deleteDatabase: (name: string) => {
        deletedDatabases.push(name);
        const request = { onsuccess: null as null | (() => void), onerror: null, onblocked: null };
        setTimeout(() => request.onsuccess?.(), 0);
        return request;
      },
    });
    return { deletedCaches, deletedDatabases };
  }

  /** Klickar Logga ut och väntar tills appen har skickat vidare till Access, hur lång tid rensningen än tar. */
  async function logOut(assign: { mock: { calls: unknown[] } }) {
    at("/installningar");
    fireEvent.click(screen.getByRole("button", { name: "Logga ut och rensa enheten" }));
    await act(async () => {
      await vi.waitFor(() => {
        expect(assign.mock.calls.length).toBeGreaterThan(0);
      });
    });
  }

  it("tömmer Cache Storage, IndexedDB och lagringen i webbläsaren, och skickar sedan till Access utloggning (KK-35-A)", async () => {
    const stores = fakeStores();
    window.localStorage.setItem("x", "1");
    window.sessionStorage.setItem("y", "2");
    const order: string[] = [];
    const assign = vi.spyOn(browser, "assign").mockImplementation((url) => {
      order.push(`assign ${url} caches=${String(stores.deletedCaches.length)} db=${String(stores.deletedDatabases.length)}`);
    });
    await logOut(assign);
    expect(stores.deletedCaches).toEqual(["api-v1", "skal-v1"]);
    expect(stores.deletedDatabases).toEqual(["kronkoll"]);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(order).toEqual(["assign /cdn-cgi/access/logout caches=2 db=1"]);
  });

  it("loggar ut även om något inte går att rensa", async () => {
    fakeStores({ failCaches: true });
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    await logOut(assign);
    expect(assign).toHaveBeenCalledWith("/cdn-cgi/access/logout");
  });

  it("loggar ut i en webbläsare utan Cache Storage och IndexedDB", async () => {
    vi.stubGlobal("caches", undefined);
    vi.stubGlobal("indexedDB", undefined);
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    await logOut(assign);
    expect(assign).toHaveBeenCalledWith("/cdn-cgi/access/logout");
  });
});
