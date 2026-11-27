// @vitest-environment jsdom
// Sidan /_design (KK-65-E): visar designsystemets grund så att ägaren kan granska den i båda lägena.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import css from "../styles/tokens.css?raw";
import DesignPage from "./DesignPage.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  window.localStorage.clear();
});

/** Alla färgtokens i ljust läge, t.ex. "surface". */
const colorTokens = () => {
  const block = css.slice(css.indexOf(":root {"), css.indexOf("}"));
  return [...block.matchAll(/--([a-z-]+):\s*#[0-9a-fA-F]{6}\s*;/gu)].map((m) => m[1] ?? "");
};

describe("designsidan (KK-65-E)", () => {
  it("visar varje färgtoken från tokens.css", () => {
    render(<DesignPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Designsystem" })).toBeDefined();
    const tokens = colorTokens();
    expect(tokens.length).toBeGreaterThan(20);
    for (const name of tokens) expect(screen.getByText(`--${name}`)).toBeDefined();
  });

  it("visar typografi, avstånd, radier, skuggor och rörelse", () => {
    render(<DesignPage />);
    for (const name of ["Knappar", "Formulär", "Ytor", "Diagram", "Etiketter", "Listrader", "Färger", "Typografi", "Avstånd", "Radier", "Skuggor", "Rörelse"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeDefined();
    }
    // Stort saldo med tabellsiffror (KK-65-D).
    expect(screen.getByText("12 345,67 kr").className).toContain("ui-display");
  });

  it("byter mellan ljust och mörkt läge med knappar", () => {
    render(<DesignPage />);
    fireEvent.click(screen.getByRole("button", { name: "Mörkt" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: "Mörkt" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Ljust" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("formulärdelarna går att använda", () => {
    render(<DesignPage />);
    fireEvent.click(screen.getByRole("radio", { name: "År" }));
    expect(screen.getByRole("radio", { name: "År" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Notiser om stora köp" }));
    expect(screen.getByRole("switch", { name: "Notiser om stora köp" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.change(screen.getByLabelText("Budget för Mat"), { target: { value: "300" } });
    expect(screen.getByLabelText<HTMLInputElement>("Budget för Mat").value).toBe("300");
  });

  it("öppnar och stänger arket och dialogen", () => {
    render(<DesignPage />);
    fireEvent.click(screen.getByRole("button", { name: "Öppna ark" }));
    fireEvent.click(screen.getByRole("button", { name: /Mat/u }));
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Öppna dialog" }));
    expect(screen.getByRole("dialog", { hidden: true, name: "Ta bort regeln?" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { hidden: true, name: "Avbryt" }));
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
  });

  it("spelar upp inträdet igen", () => {
    render(<DesignPage />);
    const before = screen.getByTestId("motion-demo");
    fireEvent.click(screen.getByRole("button", { name: "Spela upp" }));
    expect(screen.getByTestId("motion-demo")).not.toBe(before);
  });
});
