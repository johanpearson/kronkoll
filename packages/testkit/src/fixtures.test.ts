import { describe, expect, it } from "vitest";
import { FICTIONAL_COUNTERPARTIES, createRng, syntheticTransaction, syntheticTransactions } from "./fixtures.ts";

describe("syntetisk testdata (KK-13-B)", () => {
  it("ger samma data för samma frö", () => {
    expect(syntheticTransactions(5, { seed: 42 })).toEqual(syntheticTransactions(5, { seed: 42 }));
  });

  it("ger olika data för olika frön", () => {
    expect(syntheticTransactions(5, { seed: 1 })).not.toEqual(syntheticTransactions(5, { seed: 2 }));
  });

  it("använder bara påhittade motparter och heltal öre", () => {
    for (const tx of syntheticTransactions(200, { seed: 7 })) {
      expect(FICTIONAL_COUNTERPARTIES).toContain(tx.counterparty);
      expect(Number.isSafeInteger(tx.amountMinor)).toBe(true);
      expect(tx.amountMinor).not.toBe(0);
      expect(tx.description).toMatch(/^FIKTIV /);
    }
  });

  it("ger giltiga datum inom perioden och unika id", () => {
    const txs = syntheticTransactions(100, { seed: 3, from: "2026-10-01", days: 31 });
    for (const tx of txs) {
      expect(tx.date >= "2026-10-01" && tx.date <= "2026-10-31").toBe(true);
    }
    expect(new Set(txs.map((t) => t.id)).size).toBe(100);
  });

  it("låter ett test skriva över enskilda fält", () => {
    const tx = syntheticTransaction(createRng(1), 0, { amountMinor: -124000, status: "pending" });
    expect(tx.amountMinor).toBe(-124000);
    expect(tx.status).toBe("pending");
  });

  it("slumptalen ligger i [0, 1)", () => {
    const rng = createRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
