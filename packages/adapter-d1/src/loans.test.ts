import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loanRepository, type LoanRecord } from "./loans.ts";
import { migratedDb } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await db.prepare(`DELETE FROM loans`).run();
});

/** Påhittade lån (KK-13). */
const del1: LoanRecord = { id: "l1", name: "Bolån del 1", lender: "Exempelbanken", balanceMinor: 120_000_000, interestRateBp: 350, rateFixedUntil: "2026-12-15", amortizationMinor: 200_000 };
const bil: LoanRecord = { id: "l2", name: "Billån", lender: null, balanceMinor: 8_600_000, interestRateBp: 695, rateFixedUntil: null, amortizationMinor: 245_000 };

describe("lån i D1 (KK-36)", () => {
  it("sparar lån och läser dem i den ordning de lades till", async () => {
    const repo = loanRepository(db);
    expect(await repo.save(del1)).toBe(true);
    expect(await repo.save(bil)).toBe(true);
    expect(await repo.list()).toEqual([del1, bil]);
  });

  it("ändrar ett lån med samma id i stället för att lägga till ett nytt", async () => {
    const repo = loanRepository(db);
    await repo.save(del1);
    expect(await repo.save({ ...del1, balanceMinor: 119_800_000, rateFixedUntil: null, lender: null })).toBe(false);
    expect(await repo.list()).toEqual([{ ...del1, balanceMinor: 119_800_000, rateFixedUntil: null, lender: null }]);
  });

  it("tar bort ett lån, och säger till om det inte fanns", async () => {
    const repo = loanRepository(db);
    await repo.save(del1);
    expect(await repo.remove("l1")).toBe(true);
    expect(await repo.remove("l1")).toBe(false);
    expect(await repo.list()).toEqual([]);
  });

  it("databasen stoppar ogiltiga lån", async () => {
    const repo = loanRepository(db);
    const invalid: LoanRecord[] = [
      { ...del1, name: " " },
      { ...del1, name: "x".repeat(61) },
      { ...del1, lender: "x".repeat(61) },
      { ...del1, balanceMinor: -1 },
      { ...del1, interestRateBp: -1 },
      { ...del1, interestRateBp: 10_001 },
      { ...del1, amortizationMinor: -1 },
      { ...del1, rateFixedUntil: "15 dec" },
    ];
    for (const loan of invalid) await expect(repo.save(loan)).rejects.toThrow();
    expect(await repo.list()).toEqual([]);
  });
});
