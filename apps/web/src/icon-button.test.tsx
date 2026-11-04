// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Pencil } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconButton, PeriodNav } from "./icon-button.tsx";

afterEach(cleanup);

describe("ikonknappar (KK-26-E, V-u-iconbutton)", () => {
  it("har etiketten som namn och tooltip men ingen synlig text", () => {
    const onClick = vi.fn();
    render(<IconButton label="Ändra kategori för Exempelbutiken" icon={Pencil} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Ändra kategori för Exempelbutiken" });
    expect(button.getAttribute("title")).toBe("Ändra kategori för Exempelbutiken");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("kan skicka ett formulär och visa att något pågår", () => {
    render(<IconButton type="submit" label="Synkar…" icon={Pencil} disabled busy spin />);
    const button = screen.getByRole("button", { name: "Synkar…" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("spin");
  });

  it("byter period med pilarna och visar periodens datum mellan dem", () => {
    const onGo = vi.fn();
    const { container } = render(<PeriodNav period={{ start: "2026-11-01", end: "2026-11-30" }} onGo={onGo} />);
    expect(container.querySelector(".period-nav span")?.textContent).toBe("1 nov. 2026 – 30 nov. 2026");
    fireEvent.click(screen.getByRole("button", { name: "Föregående period" }));
    fireEvent.click(screen.getByRole("button", { name: "Nästa period" }));
    expect(onGo.mock.calls).toEqual([[-1], [1]]);
  });

  it("pilarna går inte att trycka på innan perioden är hämtad", () => {
    render(<PeriodNav period={null} onGo={vi.fn()} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Nästa period" }).disabled).toBe(true);
  });
});
