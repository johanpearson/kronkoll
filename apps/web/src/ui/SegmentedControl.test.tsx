// @vitest-environment jsdom
// Segmentkontroll (KK-65-A): ett val av några få, t.ex. Månad eller År. Fungerar som radioknappar,
// också med piltangenterna.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl.tsx";

afterEach(cleanup);

const OPTIONS = [
  { value: "month", label: "Månad" },
  { value: "year", label: "År" },
  { value: "all", label: "Allt" },
] as const;

function setup(value: "month" | "year" | "all" = "month") {
  const onChange = vi.fn();
  render(<SegmentedControl label="Period" options={OPTIONS} value={value} onChange={onChange} />);
  return onChange;
}

describe("SegmentedControl (KK-65-A)", () => {
  it("är en grupp radioknappar där det valda är markerat och går att nå med tab", () => {
    setup("year");
    expect(screen.getByRole("radiogroup", { name: "Period" })).toBeDefined();
    const [month, year, all] = screen.getAllByRole("radio");
    expect(year?.getAttribute("aria-checked")).toBe("true");
    expect(month?.getAttribute("aria-checked")).toBe("false");
    expect(year?.tabIndex).toBe(0);
    expect(month?.tabIndex).toBe(-1);
    expect(all?.tabIndex).toBe(-1);
  });

  it("väljer med klick", () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole("radio", { name: "Allt" }));
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it("flyttar med piltangenterna och går runt i ändarna", () => {
    const onChange = setup("month");
    const month = screen.getByRole("radio", { name: "Månad" });
    fireEvent.keyDown(month, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("year");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "År" }));
    fireEvent.keyDown(month, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("all");
    fireEvent.keyDown(month, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("year");
    fireEvent.keyDown(month, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("all");
  });

  it("struntar i andra tangenter", () => {
    const onChange = setup();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Månad" }), { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
