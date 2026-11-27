// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { startHistory } from "./router.tsx";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function at(path: string) {
  window.history.replaceState(null, "", path);
  startHistory();
  return render(<App />);
}

describe("appskalet (#30, KK-4)", () => {
  it("visar översikten som startsida, på svenska", () => {
    at("/");
    expect(screen.getByRole("heading", { level: 1, name: "Översikt" })).toBeDefined();
    expect(document.documentElement.lang === "" || document.documentElement.lang === "sv").toBe(true);
  });

  it("visar en sida som inte finns, med väg tillbaka till start", async () => {
    at("/finns-inte");
    expect(screen.getByRole("heading", { name: "Sidan finns inte" })).toBeDefined();
    fireEvent.click(screen.getByRole("link", { name: "Till start" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Sidan finns inte" })).toBeNull();
    });
    expect(window.location.pathname).toBe("/");
  });

  it("följer webbläsarens bakåt och framåt", () => {
    at("/");
    act(() => {
      // Det webbläsaren gör vid bakåt: adressen byts och popstate skickas.
      window.history.replaceState(null, "", "/finns-inte");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("heading", { name: "Sidan finns inte" })).toBeDefined();
  });

  it("visar designsidan /_design i utvecklingsläget (KK-65-E)", async () => {
    expect(import.meta.env.DEV).toBe(true);
    at("/_design");
    expect(await screen.findByRole("heading", { level: 1, name: "Designsystem" })).toBeDefined();
  });

  it("en länk med modifierare öppnas som vanligt av webbläsaren", () => {
    at("/finns-inte");
    const link = screen.getByRole("link", { name: "Till start" });
    const notPrevented = fireEvent.click(link, { ctrlKey: true });
    expect(notPrevented).toBe(true);
    expect(window.location.pathname).toBe("/finns-inte");
  });
});
