// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOAST_MS, ToastProvider, useToast } from "./toast.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Buttons() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => { toast.done("Synken är klar."); }}>Bra</button>
      <button type="button" onClick={() => { toast.problem("Det gick inte att starta synken."); }}>Fel</button>
    </>
  );
}

function setup() {
  vi.useFakeTimers();
  render(
    <ToastProvider>
      <Buttons />
    </ToastProvider>,
  );
  return (name: "Bra" | "Fel") => {
    fireEvent.click(screen.getByRole("button", { name }));
  };
}

describe("notiser (KK-26-C, V-u-toast)", () => {
  it("en bekräftelse läses upp som status och försvinner efter fyra sekunder", () => {
    const click = setup();
    click("Bra");
    expect(screen.getByRole("status").textContent).toBe("Synken är klar.");
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1); });
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(TOAST_MS).toBe(4000);
  });

  it("ett fel ligger kvar tills användaren stänger det", () => {
    const click = setup();
    click("Fel");
    act(() => { vi.advanceTimersByTime(TOAST_MS * 10); });
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att starta synken.");
    fireEvent.click(screen.getByRole("button", { name: "Stäng" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("en ny notis ersätter den förra och får sin egen tid", () => {
    const click = setup();
    click("Fel");
    click("Bra");
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1000); });
    click("Bra");
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1); });
    expect(screen.queryByRole("status")).not.toBeNull();
  });

  it("kräver ToastProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Buttons />)).toThrow("useToast kräver ToastProvider");
  });
});
