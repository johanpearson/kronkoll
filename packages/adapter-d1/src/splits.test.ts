import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveKeys } from "./crypto.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { splitRepository } from "./splits.ts";
import { migratedDb, randomSecret } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
});
afterAll(async () => {
  await dispose();
});

/** Påhittade transaktioner (KK-13). */
beforeEach(async () => {
  await db.prepare(`DELETE FROM transactions`).run();
  await db.batch(
    [
      ["t1", "booked", -124000],
      ["t2", "removed", -5000],
    ].map(([id, status, amount]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm)
           VALUES (?, 'acc_1', 'fp', ?, '2026-10-31', '2026-10-31', ?, 'CLAS OHLSON', 'CLAS OHLSON')`,
        )
        .bind(id, status, amount),
    ),
  );
});

let seq = 0;
const newId = () => `s-${String(++seq)}`;

describe("uppdelningar i D1 (KK-19)", () => {
  it("ger beloppet för en transaktion som går att dela upp, men inte för en borttagen", async () => {
    const repo = splitRepository(db);
    expect(await repo.amountOf("t1")).toBe(-124000);
    expect(await repo.amountOf("t2")).toBeNull();
    expect(await repo.amountOf("saknas")).toBeNull();
  });

  it("ersätter delarna i en batch och läser tillbaka dem i samma ordning", async () => {
    const repo = splitRepository(db);
    await repo.replace("t1", [{ categoryId: "hushall-forbrukning", amountMinor: -90000 }, { categoryId: "fritid-hobby", amountMinor: -34000 }], newId);
    await repo.replace("t1", [{ categoryId: "mat-livsmedel", amountMinor: -100000 }, { categoryId: "hushall-forbrukning", amountMinor: -24000 }], newId);
    expect(await repo.get("t1")).toEqual([
      { categoryId: "mat-livsmedel", amountMinor: -100000 },
      { categoryId: "hushall-forbrukning", amountMinor: -24000 },
    ]);
  });

  it("en tom lista tar bort uppdelningen", async () => {
    const repo = splitRepository(db);
    await repo.replace("t1", [{ categoryId: "mat-livsmedel", amountMinor: -100000 }, { categoryId: "hushall-forbrukning", amountMinor: -24000 }], newId);
    await repo.replace("t1", [], newId);
    expect(await repo.get("t1")).toEqual([]);
  });

  it("en del med okänd kategori rullar tillbaka hela ändringen", async () => {
    const repo = splitRepository(db);
    await repo.replace("t1", [{ categoryId: "mat-livsmedel", amountMinor: -100000 }, { categoryId: "hushall-forbrukning", amountMinor: -24000 }], newId);
    await expect(repo.replace("t1", [{ categoryId: "finns-inte", amountMinor: -124000 }, { categoryId: "mat-livsmedel", amountMinor: 0 }], newId)).rejects.toThrow();
    expect(await repo.get("t1")).toHaveLength(2);
  });
});
