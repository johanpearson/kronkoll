// @vitest-environment jsdom
// Ark nerifrån och dialog (KK-65-A): webbläsarens <dialog> som modal, så att fokus stannar i den,
// Esc stänger och resten av sidan är spärrad.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, Sheet } from "./Modal.tsx";

// jsdom saknar showModal och close. Testerna gör samma sak som webbläsaren: sätter och tar bort open.
const proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
beforeEach(() => {
  proto.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  proto.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

afterEach(() => {
  cleanup();
  delete proto.showModal;
  delete proto.close;
});

describe("Sheet (KK-65-A)", () => {
  it("öppnas som modal med rubriken som namn och en stängknapp", () => {
    const onClose = vi.fn();
    render(
      <Sheet open title="Välj kategori" onClose={onClose}>
        <p>Innehåll</p>
      </Sheet>,
    );
    const sheet = screen.getByRole("dialog", { name: "Välj kategori" });
    expect(sheet.className).toBe("ui-sheet");
    expect(proto.showModal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Stäng" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stängs med Esc och vid tryck utanför, men inte vid tryck i innehållet", () => {
    const onClose = vi.fn();
    render(
      <Sheet open title="Välj kategori" onClose={onClose}>
        <p>Innehåll</p>
      </Sheet>,
    );
    const sheet = screen.getByRole("dialog");
    fireEvent.click(screen.getByText("Innehåll"));
    expect(onClose).not.toHaveBeenCalled();
    // Utanför arket träffar klicket själva <dialog>, eftersom bakgrunden hör till den.
    fireEvent.click(sheet);
    expect(onClose).toHaveBeenCalledTimes(1);
    const cancel = new Event("cancel", { cancelable: true });
    sheet.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stängs när open blir falskt, och ritas inte alls innan dess", () => {
    const { rerender } = render(
      <Sheet open={false} title="Välj kategori" onClose={() => undefined}>
        <p>Innehåll</p>
      </Sheet>,
    );
    expect(screen.queryByText("Innehåll")).toBeNull();
    rerender(
      <Sheet open title="Välj kategori" onClose={() => undefined}>
        <p>Innehåll</p>
      </Sheet>,
    );
    expect(screen.getByText("Innehåll")).toBeDefined();
    rerender(
      <Sheet open={false} title="Välj kategori" onClose={() => undefined}>
        <p>Innehåll</p>
      </Sheet>,
    );
    expect(proto.close).toHaveBeenCalled();
    expect(screen.queryByText("Innehåll")).toBeNull();
  });

  it("ger fokus åt fältet märkt data-autofocus efter showModal", () => {
    render(
      <Sheet open title="Byt namn" onClose={() => undefined}>
        <input aria-label="Namn" data-autofocus />
      </Sheet>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Namn"));
  });

  it("öppnas ändå i en webbläsare utan showModal", () => {
    delete proto.showModal;
    render(
      <Sheet open title="Välj kategori" onClose={() => undefined}>
        <p>Innehåll</p>
      </Sheet>,
    );
    expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true);
  });
});

describe("bakåtknappen (KK-62-E)", () => {
  it("stänger arket i stället för att lämna vyn", async () => {
    // Tidigare test kan ha lämnat arksteg efter sig. Vänta ut dem och börja på ett vanligt steg.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    window.history.pushState({ stack: ["/", "/budget"] }, "", "/budget");
    const onClose = vi.fn();
    render(
      <Sheet open title="Välj kategori" onClose={onClose}>
        <p>Innehåll</p>
      </Sheet>,
    );
    expect((window.history.state as { overlay?: boolean }).overlay).toBe(true);
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe("/budget");
  });
});

describe("Dialog (KK-65-A)", () => {
  it("frågar med rubrik, text och knappar, och stängs med Esc", () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Ta bort regeln?" actions={<button type="button">Ta bort</button>} onClose={onClose}>
        Transaktionerna behåller sina kategorier.
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Ta bort regeln?" });
    expect(dialog.className).toBe("ui-dialog");
    expect(dialog.getAttribute("aria-describedby")).toBe(screen.getByText("Transaktionerna behåller sina kategorier.").id);
    expect(screen.getByRole("button", { name: "Ta bort" })).toBeDefined();
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
