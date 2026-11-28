// @vitest-environment jsdom
// Varför den här kategorin? (#251, KK-58-D): vad som gav transaktionen sin kategori, och vilka andra regler som träffar.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CategoryReason, toReason, type Reason } from "./CategoryReason.tsx";

afterEach(cleanup);

const IKEA = { id: "r-ikea", match: "counterparty_prefix", pattern: "IKEA", category_id: "hushall", source: "learned" };
const AMAZON = { id: "r-amazon", match: "description_contains", pattern: "AMAZON", category_id: "shopping", source: "learned" };
const MALL = { id: "r-mall", match: "counterparty_prefix", pattern: "IKEA KUNGENS", category_id: "boende", source: "template" };
const names = new Map([["hushall", "Hushåll"], ["shopping", "Shopping › Nätköp"], ["boende", "Boende"]]);

function show(raw: unknown) {
  const reason = toReason(raw);
  if (!reason) throw new Error("ingen förklaring");
  render(<CategoryReason reason={reason} names={names} />);
  fireEvent.click(screen.getByRole("button", { name: "Varför den här kategorin?" }));
  return within(screen.getByRole("dialog", { name: "Varför den här kategorin?" }));
}

describe("förklaringen av en kategori (KK-58-D)", () => {
  it("en kategori som du valde själv ändras aldrig av regler", () => {
    const sheet = show({ source: "manual", rule: null, also_matched: [] });
    expect(sheet.getByText("Du valde kategorin själv, så regler ändrar den aldrig.")).toBeTruthy();
    expect(sheet.queryByRole("list")).toBeNull();
  });

  it("en egen regel som vann nämns med villkoret, och de som också träffar listas i den ordning de vinner", () => {
    const sheet = show({ source: "learned", rule: IKEA, also_matched: [AMAZON, MALL] });
    expect(sheet.getByText("Regeln Börjar med IKEA → Hushåll gav kategorin. Det är en av dina egna regler.")).toBeTruthy();
    expect(sheet.getByText("Andra regler som också träffar, i den ordning de vinner:")).toBeTruthy();
    const rows = within(sheet.getByRole("list", { name: "Regler som också träffar" })).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".ui-row-label")?.textContent)).toEqual(["Innehåller AMAZON → Shopping › Nätköp", "Börjar med IKEA KUNGENS → Boende"]);
    expect(rows.map((r) => r.querySelector(".ui-row-detail")?.textContent)).toEqual(["Egen regel", "Mallregel"]);
  });

  it("en mallregel säger det", () => {
    const sheet = show({ source: "template", rule: MALL, also_matched: [] });
    expect(sheet.getByText("Regeln Börjar med IKEA KUNGENS → Boende gav kategorin. Det är en mallregel.")).toBeTruthy();
    expect(sheet.queryByRole("list")).toBeNull();
  });

  it("en kategori från en regel som sedan har ändrats säger det, och listar reglerna som träffar nu", () => {
    const sheet = show({ source: "learned", rule: null, also_matched: [AMAZON] });
    expect(sheet.getByText("Kategorin kom från en regel som sedan har ändrats eller tagits bort. Transaktionen behåller den.")).toBeTruthy();
    expect(sheet.getByText("Regler som träffar den här transaktionen, i den ordning de vinner:")).toBeTruthy();
    expect(within(sheet.getByRole("list", { name: "Regler som också träffar" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("utan kategori och utan träffande regler säger den det", () => {
    const sheet = show({ source: "none", rule: null, also_matched: [] });
    expect(sheet.getByText("Ingen kategori är vald, och ingen regel träffar den här transaktionen.")).toBeTruthy();
  });

  it("utan kategori men med träffande regler listas de", () => {
    const sheet = show({ source: "none", rule: null, also_matched: [IKEA] });
    expect(sheet.getByText("Ingen kategori är satt än. Dessa regler träffar:")).toBeTruthy();
  });

  it("en kategori som inte går att slå upp visas med sitt id, och Stäng stänger arket", () => {
    render(<CategoryReason reason={toReason({ source: "learned", rule: IKEA, also_matched: [] }) as Reason} names={new Map()} />);
    fireEvent.click(screen.getByRole("button", { name: "Varför den här kategorin?" }));
    expect(screen.getByText("Regeln Börjar med IKEA → hushall gav kategorin. Det är en av dina egna regler.")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stäng" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ett svar utan förklaring ger ingen, och en regel utan id eller mönster hoppas över", () => {
    expect(toReason(undefined)).toBeNull();
    expect(toReason({ rule: null })).toBeNull();
    expect(toReason({ source: "learned", rule: null, also_matched: [{ id: 5 }, { id: "r", pattern: "X", category_id: "hushall", source: "learned", match: "counterparty_prefix" }] })?.alsoMatched).toHaveLength(1);
  });
});
