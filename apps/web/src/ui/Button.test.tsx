// @vitest-environment jsdom
// Knappar i designsystemet (KK-65-A, KK-26-E): fyra varianter, ikonknapp med etikett och alltid <button>.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Plus, Trash2 } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./Button.tsx";

afterEach(cleanup);

describe("Button (KK-65-A)", () => {
  it.each(["primary", "secondary", "quiet", "danger"] as const)("varianten %s är en riktig knapp med sin klass", (variant) => {
    const onClick = vi.fn();
    render(
      <Button variant={variant} onClick={onClick}>
        Spara
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Spara" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toBe(`ui-button ui-button-${variant}`);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("är sekundär om inget annat sägs, och kan fylla bredden", () => {
    render(<Button block>Avbryt</Button>);
    expect(screen.getByRole("button", { name: "Avbryt" }).className).toBe("ui-button ui-button-secondary ui-button-block");
  });

  it("visar en ikon före texten, dold för skärmläsare", () => {
    render(<Button icon={Plus}>Ny regel</Button>);
    const svg = screen.getByRole("button", { name: "Ny regel" }).querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("kan skicka ett formulär, och är låst medan något pågår", () => {
    const onClick = vi.fn();
    render(
      <Button type="submit" variant="primary" busy onClick={onClick}>
        Sparar…
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Sparar…" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("kan vara avstängd", () => {
    render(<Button disabled>Spara</Button>);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Spara" }).disabled).toBe(true);
  });
});

describe("IconButton (KK-26-E)", () => {
  it("har etiketten som namn och tooltip men ingen synlig text", () => {
    const onClick = vi.fn();
    render(<IconButton label="Ta bort regeln" icon={Trash2} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Ta bort regeln" });
    expect(button.getAttribute("title")).toBe("Ta bort regeln");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toBe("ui-icon-button");
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("kan vara fara, avstängd och upptagen", () => {
    render(<IconButton label="Ta bort" icon={Trash2} danger disabled busy />);
    const button = screen.getByRole("button", { name: "Ta bort" });
    expect(button.className).toBe("ui-icon-button ui-icon-button-danger");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
