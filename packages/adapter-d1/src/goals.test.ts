import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveKeys, type Keys } from "./crypto.ts";
import { goalRepository, type NewGoal } from "./goals.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let keys: Keys;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  keys = await deriveKeys(randomSecret());
});
afterAll(async () => {
  await dispose();
});

/** Påhittade mål, konton och transaktioner (KK-13). */
beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM savings_goals`), db.prepare(`DELETE FROM bank_connections`)]);
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Exempelbanken" });
  await accountRepository(db, keys).upsertFromBank(
    { connectionId: "c1", providerUid: "u1", iban: null, name: "Sparkonto", type: "savings", balanceMinor: 7_400_000 },
    () => "acc_spar",
  );
});

const japan: NewGoal = { name: "Resa till Japan", targetMinor: 6_000_000, targetDate: "2027-08-31", source: "manual", accountId: null, initialMinor: 1_500_000 };
const buffert: NewGoal = { name: "Buffert", targetMinor: 10_000_000, targetDate: null, source: "account", accountId: "acc_spar", initialMinor: 0 };

async function transaction(id: string, status: string, transactionDate: string, bookingDate: string | null, amountMinor: number) {
  await db
    .prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor)
       VALUES (?, 'acc_spar', 'fp', ?, ?, ?, ?, ?)`,
    )
    .bind(id, status, transactionDate, transactionDate, bookingDate, amountMinor)
    .run();
}

describe("sparmål i D1 (KK-21)", () => {
  it("sparar mål och läser dem i den ordning de skapades", async () => {
    const repo = goalRepository(db);
    await repo.create(japan, "g1");
    await repo.create(buffert, "g2");
    expect(await repo.list()).toEqual([
      { id: "g1", ...japan },
      { id: "g2", ...buffert },
    ]);
    expect(await repo.get("g2")).toEqual({ id: "g2", ...buffert });
    expect(await repo.get("saknas")).toBeNull();
  });

  it("databasen stoppar ogiltiga mål", async () => {
    const repo = goalRepository(db);
    const invalid: NewGoal[] = [
      { ...japan, accountId: "acc_spar" },
      { ...japan, targetMinor: 0 },
      { ...japan, initialMinor: -1 },
      { ...japan, name: "  " },
      { ...japan, name: "x".repeat(61) },
      { ...japan, targetDate: "31 aug 2027" },
    ];
    for (const [i, goal] of invalid.entries()) await expect(repo.create(goal, `bad-${String(i)}`)).rejects.toThrow();
    expect(await repo.list()).toEqual([]);
  });

  it("avsättningar läses nyast först och bara för sitt mål", async () => {
    const repo = goalRepository(db);
    await repo.create(japan, "g1");
    await repo.create({ ...japan, name: "Annat" }, "g3");
    expect(await repo.addContribution("g1", { date: "2026-09-27", amountMinor: 340_000 }, "a1")).toBe(true);
    expect(await repo.addContribution("g1", { date: "2026-10-28", amountMinor: 300_000 }, "a2")).toBe(true);
    expect(await repo.addContribution("g1", { date: "2026-10-28", amountMinor: -50_000 }, "a3")).toBe(true);
    expect(await repo.addContribution("g3", { date: "2026-10-01", amountMinor: 100 }, "a4")).toBe(true);
    expect(await repo.contributions("g1")).toEqual([
      { id: "a3", date: "2026-10-28", amountMinor: -50_000 },
      { id: "a2", date: "2026-10-28", amountMinor: 300_000 },
      { id: "a1", date: "2026-09-27", amountMinor: 340_000 },
    ]);
  });

  it("ändrar namn, belopp, måldatum och redan sparat, men bara på rätt mål (KK-21-C)", async () => {
    const repo = goalRepository(db);
    await repo.create(japan, "g1");
    await repo.create(buffert, "g2");
    expect(await repo.update("g1", { name: "Japan och Korea", targetMinor: 7_000_000, targetDate: null, initialMinor: 0 })).toBe(true);
    expect(await repo.get("g1")).toEqual({ ...japan, id: "g1", name: "Japan och Korea", targetMinor: 7_000_000, targetDate: null, initialMinor: 0 });
    expect(await repo.get("g2")).toEqual({ id: "g2", ...buffert });
    expect(await repo.update("saknas", { name: "x" })).toBe(false);
    await expect(repo.update("g1", { targetMinor: 0 })).rejects.toThrow();
    await expect(repo.update("g1", { name: " " })).rejects.toThrow();
  });

  it("tar bort ett mål med dess avsättningar, och en avsättning bara i sitt eget mål (KK-21-C)", async () => {
    const repo = goalRepository(db);
    await repo.create(japan, "g1");
    await repo.create({ ...japan, name: "Annat" }, "g3");
    await repo.addContribution("g1", { date: "2026-09-27", amountMinor: 340_000 }, "a1");
    await repo.addContribution("g1", { date: "2026-10-28", amountMinor: 300_000 }, "a2");
    await repo.addContribution("g3", { date: "2026-10-01", amountMinor: 100 }, "a4");
    expect(await repo.removeContribution("g3", "a1")).toBe(false);
    expect(await repo.removeContribution("g1", "a1")).toBe(true);
    expect(await repo.contributions("g1")).toEqual([{ id: "a2", date: "2026-10-28", amountMinor: 300_000 }]);
    expect(await repo.remove("g1")).toBe(true);
    expect(await repo.remove("g1")).toBe(false);
    expect(await repo.list()).toEqual([{ id: "g3", ...japan, name: "Annat" }]);
    expect((await db.prepare(`SELECT id FROM goal_contributions`).all<{ id: string }>()).results).toEqual([{ id: "a4" }]);
  });

  it("en avsättning till ett mål som inte finns sparas inte, och en avsättning på 0 kr stoppas", async () => {
    const repo = goalRepository(db);
    expect(await repo.addContribution("saknas", { date: "2026-10-28", amountMinor: 300_000 }, "a1")).toBe(false);
    await repo.create(japan, "g1");
    await expect(repo.addContribution("g1", { date: "2026-10-28", amountMinor: 0 }, "a2")).rejects.toThrow();
    await expect(repo.addContribution("g1", { date: "28/10", amountMinor: 100 }, "a3")).rejects.toThrow();
  });

  it("tas målet bort försvinner dess avsättningar", async () => {
    const repo = goalRepository(db);
    await repo.create(japan, "g1");
    await repo.addContribution("g1", { date: "2026-10-28", amountMinor: 300_000 }, "a1");
    await db.prepare(`DELETE FROM savings_goals WHERE id = 'g1'`).run();
    expect((await db.prepare(`SELECT count(*) AS n FROM goal_contributions`).first<{ n: number }>())?.n).toBe(0);
  });

  it("raderas kopplingen blir målet kvar, utan konto", async () => {
    const repo = goalRepository(db);
    await repo.create(buffert, "g2");
    await db.prepare(`DELETE FROM bank_connections WHERE id = 'c1'`).run();
    expect(await repo.get("g2")).toEqual({ id: "g2", ...buffert, accountId: null });
  });

  it("ger kontots saldo och rörelser från och med ett datum, utan borttagna", async () => {
    await transaction("t1", "booked", "2026-10-25", "2026-10-26", 500_000);
    await transaction("t2", "pending", "2026-11-02", null, -80_000);
    await transaction("t3", "removed", "2026-10-30", null, 999_900);
    await transaction("t4", "booked", "2026-07-31", "2026-08-01", 200_000);
    await transaction("t5", "booked", "2026-07-30", "2026-07-31", 100_000);
    expect(await goalRepository(db).account("acc_spar", "2026-08-01")).toEqual({
      balanceMinor: 7_400_000,
      movements: [
        { date: "2026-11-02", amountMinor: -80_000 },
        { date: "2026-10-26", amountMinor: 500_000 },
        { date: "2026-08-01", amountMinor: 200_000 },
      ],
    });
    expect(await goalRepository(db).account("saknas", "2026-08-01")).toBeNull();
  });
});
