// @vitest-environment jsdom
// Brytare (KK-65-A): av eller på, med texten som namn.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "./Switch.tsx";

afterEach(cleanup);

describe("Switch (KK-65-A)", () => {
  it("är en brytare med texten som namn och växlar läge", () => {
    const onChange = vi.fn();
    render(
      <Switch checked={false} onChange={onChange}>
        Notiser
      </Switch>,
    );
    const toggle = screen.getByRole("switch", { name: "Notiser" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("type")).toBe("button");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("stänger av när den är på", () => {
    const onChange = vi.fn();
    render(
      <Switch checked onChange={onChange}>
        Notiser
      </Switch>,
    );
    const toggle = screen.getByRole("switch", { name: "Notiser" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("kan vara avstängd", () => {
    render(
      <Switch checked={false} disabled onChange={() => undefined}>
        Notiser
      </Switch>,
    );
    expect(screen.getByRole<HTMLButtonElement>("switch", { name: "Notiser" }).disabled).toBe(true);
  });
});
