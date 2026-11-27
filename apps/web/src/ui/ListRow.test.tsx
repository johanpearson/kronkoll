// @vitest-environment jsdom
// Listrad (KK-65-A): ikon, text, värde och chevron. En rad som gör något är en knapp, en rad som leder
// till en annan sida är en länk, och en rad som bara visar något är varken eller.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Wallet } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { List, ListRow } from "./ListRow.tsx";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("ListRow (KK-65-A)", () => {
  it("visar text, detalj och värde i en lista", () => {
    render(
      <List label="Konton">
        <ListRow icon={Wallet} label="Gemensamt" detail="Inkomst/Utgift" value="12 300 kr" />
      </List>,
    );
    const list = screen.getByRole("list", { name: "Konton" });
    expect(list.className).toBe("ui-list");
    const item = screen.getByRole("listitem");
    expect(item.textContent).toBe("GemensamtInkomst/Utgift12 300 kr");
    expect(item.querySelector(".ui-row-icon svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(item.querySelector("button, a")).toBeNull();
    expect(item.querySelector(".ui-row-chevron")).toBeNull();
  });

  it("är en knapp med chevron när raden gör något", () => {
    const onClick = vi.fn();
    render(
      <List>
        <ListRow label="Tema" value="System" onClick={onClick} />
      </List>,
    );
    const button = screen.getByRole("button", { name: /Tema/u });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toBe("ui-row");
    expect(button.querySelector(".ui-row-chevron")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("är en länk med chevron som byter sida utan omladdning", () => {
    render(
      <List>
        <ListRow label="Kategorier" to="/installningar/kategorier" />
      </List>,
    );
    const link = screen.getByRole("link", { name: /Kategorier/u });
    expect(link.getAttribute("href")).toBe("/installningar/kategorier");
    expect(link.className).toBe("ui-row");
    expect(link.querySelector(".ui-row-chevron")).not.toBeNull();
    fireEvent.click(link);
    expect(window.location.pathname).toBe("/installningar/kategorier");
  });

  it("kan visa ett fara-läge, t.ex. Ta bort koppling", () => {
    render(
      <List>
        <ListRow label="Ta bort koppling" danger onClick={() => undefined} />
      </List>,
    );
    expect(screen.getByRole("button", { name: "Ta bort koppling" }).className).toBe("ui-row ui-row-danger");
  });
});
