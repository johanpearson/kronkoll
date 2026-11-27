// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOAST_MS, ToastProvider, useToast } from "./toast.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const undo = vi.fn();

function Buttons() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => { toast.done("Synken är klar."); }}>Bra</button>
      <button type="button" onClick={() => { toast.problem("Det gick inte att starta synken."); }}>Fel</button>
      <button type="button" onClick={() => { toast.done("Transaktionen är dold.", { undo }); }}>Dölj</button>
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
  return (name: "Bra" | "Fel" | "Dölj") => {
    fireEvent.click(screen.getByRole("button", { name }));
  };
}

describe("notiser upptill (KK-64-B, D, E, F)", () => {
  it("en bekräftelse läses upp som status, visas upptill och försvinner efter tre sekunder", () => {
    const click = setup();
    click("Bra");
    expect(screen.getByRole("status").textContent).toBe("Synken är klar.");
    expect(screen.getByRole("status").parentElement?.className).toBe("ui-toasts");
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1); });
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(TOAST_MS).toBe(3000);
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

  it("en åtgärd som går att ångra har knappen Ångra, som ångrar och stänger (KK-64-F)", () => {
    const click = setup();
    undo.mockClear();
    click("Dölj");
    fireEvent.click(screen.getByRole("button", { name: "Ångra" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("en notis med Ångra stannar lite längre, så att det går att hinna trycka", () => {
    const click = setup();
    click("Dölj");
    act(() => { vi.advanceTimersByTime(TOAST_MS); });
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(TOAST_MS); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("kan sveps bort åt sidan eller uppåt, men inte med ett kort tryck", () => {
    const click = setup();
    click("Bra");
    const toast = () => screen.getByRole("status");
    fireEvent.pointerDown(toast(), { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(toast(), { clientX: 110, clientY: 104 });
    expect(screen.queryByRole("status")).not.toBeNull();
    fireEvent.pointerDown(toast(), { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(toast(), { clientX: 220, clientY: 100 });
    expect(screen.queryByRole("status")).toBeNull();
    click("Fel");
    fireEvent.pointerDown(screen.getByRole("alert"), { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(screen.getByRole("alert"), { clientX: 100, clientY: 20 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ett svep som avbryts räknas inte", () => {
    const click = setup();
    click("Bra");
    fireEvent.pointerUp(screen.getByRole("status"), { clientX: 400, clientY: 100 });
    expect(screen.queryByRole("status")).not.toBeNull();
  });

  it("kräver ToastProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Buttons />)).toThrow("useToast kräver ToastProvider");
  });
});
