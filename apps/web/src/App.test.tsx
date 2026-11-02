// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function at(path: string) {
  window.history.replaceState(null, "", path);
  return render(<App />);
}

describe("appskalet (#30, KK-4)", () => {
  it("visar startsidan på svenska", () => {
    at("/");
    expect(screen.getByRole("heading", { level: 1, name: "Kronkoll" })).toBeDefined();
    expect(document.documentElement.lang === "" || document.documentElement.lang === "sv").toBe(true);
  });

  it("visar en sida som inte finns, med väg tillbaka till start", () => {
    at("/finns-inte");
    expect(screen.getByRole("heading", { name: "Sidan finns inte" })).toBeDefined();
    fireEvent.click(screen.getByRole("link", { name: "Till start" }));
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("heading", { name: "Sidan finns inte" })).toBeNull();
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

  it("en länk med modifierare öppnas som vanligt av webbläsaren", () => {
    at("/finns-inte");
    const link = screen.getByRole("link", { name: "Till start" });
    const notPrevented = fireEvent.click(link, { ctrlKey: true });
    expect(notPrevented).toBe(true);
    expect(window.location.pathname).toBe("/finns-inte");
  });
});
