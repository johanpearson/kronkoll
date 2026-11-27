// @vitest-environment jsdom
// Inmatning för belopp (KK-65-A): kronor med decimaltangentbord, och ett tydligt fel om texten inte är
// ett belopp.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmountInput } from "./AmountInput.tsx";

afterEach(cleanup);

describe("AmountInput (KK-65-A)", () => {
  it("har etikett, decimaltangentbord och kr efter fältet", () => {
    const onChange = vi.fn();
    render(<AmountInput label="Budget" value="1 250,50" onChange={onChange} />);
    const input = screen.getByLabelText<HTMLInputElement>("Budget");
    expect(input.inputMode).toBe("decimal");
    expect(input.value).toBe("1 250,50");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText("kr").getAttribute("aria-hidden")).toBe("true");
    fireEvent.change(input, { target: { value: "300" } });
    expect(onChange).toHaveBeenCalledWith("300");
  });

  it("visar ett fel som hör till fältet när texten inte är ett belopp", () => {
    render(<AmountInput label="Budget" value="tolv" onChange={() => undefined} />);
    const input = screen.getByLabelText("Budget");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText("Skriv ett belopp i kronor, t.ex. 1 250,50.");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("räknar tomt som giltigt och kan visa en hjälptext", () => {
    render(<AmountInput label="Budget" value="" hint="Lämna tomt för ingen budget." onChange={() => undefined} />);
    const input = screen.getByLabelText("Budget");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText("Lämna tomt för ingen budget.").id);
  });
});
