// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DRAFT, clearDraft, loadDraft, saveDraft, type Draft } from "./planner-draft.ts";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const draft: Draft = { incomes: [{ id: "i1", name: "Lön", text: "40 000" }], edited: { mat: "6 000" }, saving: "3 000" };

describe("utkastet till en budgetplan (KK-42-D)", () => {
  it("sparas och läses tillbaka per period", () => {
    saveDraft("2026-11", draft);
    expect(loadDraft("2026-11")).toEqual(draft);
    expect(loadDraft("2026-12")).toEqual(EMPTY_DRAFT);
  });

  it("rensas när planen sparats eller förslaget återställts", () => {
    saveDraft("2026-11", draft);
    clearDraft("2026-11");
    expect(loadDraft("2026-11")).toEqual(EMPTY_DRAFT);
  });

  it("ett utkast utan ändrad inkomst läses tillbaka som det är", () => {
    saveDraft("2026-11", EMPTY_DRAFT);
    expect(loadDraft("2026-11")).toEqual(EMPTY_DRAFT);
  });

  it("ett trasigt utkast ger ett tomt: fel JSON, fel form och fel typer", () => {
    for (const raw of ["{", "null", "[]", '"text"', JSON.stringify({ incomes: [{ id: 1 }], edited: { a: 5 }, saving: 7 })]) {
      window.localStorage.setItem("kronkoll.plan.2026-11", raw);
      expect(loadDraft("2026-11")).toEqual(EMPTY_DRAFT);
    }
  });

  it("tar bara med det som är rätt i ett delvis trasigt utkast", () => {
    window.localStorage.setItem("kronkoll.plan.2026-11", JSON.stringify({ incomes: "fel", edited: { mat: "6 000" }, saving: "3 000" }));
    expect(loadDraft("2026-11")).toEqual({ incomes: null, edited: { mat: "6 000" }, saving: "3 000" });
  });

  it("fungerar utan lagring: läsning ger ett tomt utkast och skrivning går inte sönder", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blockerad"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blockerad"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blockerad"); });
    expect(loadDraft("2026-11")).toEqual(EMPTY_DRAFT);
    expect(() => { saveDraft("2026-11", draft); clearDraft("2026-11"); }).not.toThrow();
  });
});
