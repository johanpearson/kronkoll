import type { D1Database } from "@cloudflare/workers-types";
import { dailyBenefitMinor, type LeavePeriod } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leaveRepository } from "./leave.ts";
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
  await db.prepare(`DELETE FROM leave_periods`).run();
});

/** Påhittade perioder (KK-13). */
const spring: LeavePeriod = {
  from: "2027-03-01",
  to: "2027-08-31",
  daysPerWeek: 5,
  sgiAnnualMinor: 54_000_000,
  employerTopupPct: 10,
  taxRatePct: 31.5,
  overrideNetMonthlyMinor: null,
};
const autumn: LeavePeriod = { ...spring, from: "2026-12-01", to: "2027-01-31", daysPerWeek: 2.5, employerTopupPct: 0, overrideNetMonthlyMinor: 2_000_000 };

describe("föräldraledighet i D1 (KK-23)", () => {
  it("sparar perioder och läser dem tidigast först, med halva dagar och decimaler kvar", async () => {
    const repo = leaveRepository(db);
    await repo.create(spring, "l1");
    await repo.create(autumn, "l2");
    expect(await repo.list()).toEqual([
      { id: "l2", ...autumn },
      { id: "l1", ...spring },
    ]);
    expect(await repo.get("l1")).toEqual({ id: "l1", ...spring });
    expect(await repo.get("saknas")).toBeNull();
  });

  it("tar bort en period", async () => {
    const repo = leaveRepository(db);
    await repo.create(spring, "l1");
    expect(await repo.remove("l1")).toBe(true);
    expect(await repo.remove("l1")).toBe(false);
    expect(await repo.list()).toEqual([]);
  });

  it("databasen stoppar ogiltiga perioder", async () => {
    const repo = leaveRepository(db);
    const invalid: LeavePeriod[] = [
      { ...spring, from: "1 mars 2027" },
      { ...spring, to: "2027-8-31" },
      { ...spring, to: "2027-02-28" },
      { ...spring, daysPerWeek: 7.5 },
      { ...spring, daysPerWeek: -1 },
      { ...spring, sgiAnnualMinor: -1 },
      { ...spring, employerTopupPct: 101 },
      { ...spring, taxRatePct: -0.5 },
      { ...spring, overrideNetMonthlyMinor: -1 },
    ];
    for (const [i, period] of invalid.entries()) await expect(repo.create(period, `bad-${String(i)}`)).rejects.toThrow();
    expect(await repo.list()).toEqual([]);
  });

  it("en period på en dag med 0 och 100 procent och 0 kr är giltig", async () => {
    const repo = leaveRepository(db);
    const edge: LeavePeriod = { ...spring, to: spring.from, daysPerWeek: 0, sgiAnnualMinor: 0, employerTopupPct: 100, taxRatePct: 0, overrideNetMonthlyMinor: 0 };
    await repo.create(edge, "l1");
    expect(await repo.get("l1")).toEqual({ id: "l1", ...edge });
  });
});

describe("Försäkringskassans årsparametrar (antagande A-5)", () => {
  it("finns för 2026 och 2027 med källa", async () => {
    expect(await leaveRepository(db).parameters()).toEqual([
      { year: 2026, priceBaseAmountMinor: 5_920_000, sgiCapMultiplier: 10, benefitRate: 0.8, sgiFactor: 0.97 },
      { year: 2027, priceBaseAmountMinor: 5_960_000, sgiCapMultiplier: 10, benefitRate: 0.8, sgiFactor: 0.97 },
    ]);
    const sources = await db.prepare(`SELECT source_url AS url FROM income_parameters ORDER BY year`).all<{ url: string }>();
    expect(sources.results.map((r) => r.url)).toEqual([
      "https://www.regeringen.se/pressmeddelanden/2025/09/prisbasbelopp-for-2026-faststallt/",
      "https://www.regeringen.se/pressmeddelanden/2026/09/prisbasbeloppfor-2027-faststallt/",
    ]);
  });

  it("ger Försäkringskassans högsta dagbelopp för 2026, 1 259 kr", async () => {
    const [p2026] = await leaveRepository(db).parameters();
    expect(p2026 && dailyBenefitMinor(100_000_000, p2026)).toBe(125_900);
  });

  it("databasen stoppar ogiltiga parametrar", async () => {
    const insert = (values: string) =>
      db.prepare(`INSERT INTO income_parameters (year, price_base_amount_minor, sgi_cap_multiplier, benefit_rate, sgi_factor, source_url) VALUES ${values}`).run();
    for (const values of [
      `(1999, 5920000, 10, 0.8, 0.97, 'https://x.se')`,
      `(2030, 0, 10, 0.8, 0.97, 'https://x.se')`,
      `(2030, 5920000, 0, 0.8, 0.97, 'https://x.se')`,
      `(2030, 5920000, 10, 1.2, 0.97, 'https://x.se')`,
      `(2030, 5920000, 10, 0.8, 0, 'https://x.se')`,
      `(2030, 5920000, 10, 0.8, 0.97, 'http://x.se')`,
    ]) {
      await expect(insert(values)).rejects.toThrow();
    }
    expect(await leaveRepository(db).parameters()).toHaveLength(2);
  });
});
