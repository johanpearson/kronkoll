// @vitest-environment jsdom
// Kort, tom vy och skelett (KK-65-A).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Card, EmptyState, Skeleton } from "./Surface.tsx";

afterEach(cleanup);

describe("Card (KK-65-A)", () => {
  it("är en sektion med rubriken som namn och en valfri åtgärd", () => {
    render(
      <Card title="Buffert" action={<button type="button">Visa</button>}>
        <p>Innehåll</p>
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Buffert" });
    expect(card.className).toBe("ui-card ui-enter");
    expect(screen.getByRole("heading", { level: 2, name: "Buffert" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Visa" })).toBeDefined();
  });

  it("kan sakna rubrik", () => {
    render(
      <Card>
        <p>Bara innehåll</p>
      </Card>,
    );
    expect(screen.getByText("Bara innehåll").parentElement?.tagName).toBe("SECTION");
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("EmptyState (KK-65-A)", () => {
  it("förklarar varför det är tomt och erbjuder nästa steg", () => {
    const onClick = vi.fn();
    render(
      <EmptyState icon={Inbox} title="Inga transaktioner än" action={<button type="button" onClick={onClick}>Koppla bank</button>}>
        De kommer efter första synken.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { name: "Inga transaktioner än" })).toBeDefined();
    expect(screen.getByText("De kommer efter första synken.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Koppla bank" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("klarar sig utan ikon och åtgärd", () => {
    render(<EmptyState title="Inga regler" />);
    expect(screen.getByRole("heading", { name: "Inga regler" }).parentElement?.querySelector("svg, button")).toBeNull();
  });
});

describe("Skeleton (KK-65-A)", () => {
  it("visar grå rader medan något laddas och säger Laddar till skärmläsare", () => {
    const { container } = render(<Skeleton lines={3} />);
    expect(screen.getByRole("status").textContent).toBe("Laddar…");
    expect(container.querySelectorAll(".ui-skeleton-line")).toHaveLength(3);
  });

  it("har en rad om inget annat sägs", () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelectorAll(".ui-skeleton-line")).toHaveLength(1);
  });
});
