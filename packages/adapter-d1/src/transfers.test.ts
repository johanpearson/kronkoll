import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveKeys } from "./crypto.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";
import { transactionRepository } from "./transactions.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Budget", type: "checking", balanceMinor: 0 }, () => "acc_budget");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Spar", type: "savings", balanceMinor: 0 }, () => "acc_spar");
});
afterAll(async () => {
  await dispose();
});

/** Påhittade transaktioner (KK-13): en överföring mellan egna konton och ett köp. */
beforeEach(async () => {
  await db.prepare(`DELETE FROM transactions`).run();
  const rows: [string, string, string, number, string][] = [
    ["ut", "acc_budget", "booked", -500000, "SPARKONTO"],
    ["in", "acc_spar", "booked", 500000, "BUDGETKONTO"],
    ["kop", "acc_budget", "booked", -4500, "ESPRESSO HOUSE"],
    ["borta", "acc_budget", "removed", -100, "X"],
  ];
  await db.batch(
    rows.map(([id, account, status, amount, norm]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm)
           VALUES (?, ?, 'fp', ?, '2026-11-02', '2026-11-02', ?, ?, ?)`,
        )
        .bind(id, account, status, amount, norm, norm),
    ),
  );
});

describe("interna överföringar i D1 (KK-20-C)", () => {
  it("ger transaktionerna i domänens form med nuvarande markering, men inga borttagna", async () => {
    const rows = await transactionRepository(db).forTransfers();
    expect(rows.map((r) => r.id).sort()).toEqual(["in", "kop", "ut"]);
    expect(rows.find((r) => r.id === "ut")).toEqual({
      id: "ut",
      accountId: "acc_budget",
      transactionDate: "2026-11-02",
      amountMinor: -500000,
      counterpartyNorm: "SPARKONTO",
      description: "",
      status: "booked",
      manualTransfer: null,
      internal: false,
      pairId: null,
    });
  });

  it("sparar markering och motpost, och kan ta bort dem igen", async () => {
    const repo = transactionRepository(db);
    await repo.setTransfers([
      { id: "ut", internal: true, pairId: "in" },
      { id: "in", internal: true, pairId: "ut" },
    ]);
    expect((await repo.forTransfers()).filter((r) => r.internal).map((r) => [r.id, r.pairId]).sort()).toEqual([
      ["in", "ut"],
      ["ut", "in"],
    ]);
    await repo.setTransfers([{ id: "ut", internal: false, pairId: null }]);
    expect((await repo.forTransfers()).find((r) => r.id === "ut")).toMatchObject({ internal: false, pairId: null });
  });

  it("gör ingenting med en tom lista", async () => {
    await expect(transactionRepository(db).setTransfers([])).resolves.toBeUndefined();
  });

  it("sparar användarens eget val och läser tillbaka det som manualTransfer", async () => {
    const repo = transactionRepository(db);
    expect(await repo.setManualTransfer("kop", true)).toBe(true);
    expect((await repo.forTransfers()).find((r) => r.id === "kop")).toMatchObject({ manualTransfer: true });
    await repo.setManualTransfer("kop", false);
    expect((await repo.forTransfers()).find((r) => r.id === "kop")).toMatchObject({ manualTransfer: false });
    await repo.setManualTransfer("kop", null);
    expect((await repo.forTransfers()).find((r) => r.id === "kop")).toMatchObject({ manualTransfer: null });
  });

  it("säger till om transaktionen saknas eller är borttagen", async () => {
    const repo = transactionRepository(db);
    expect(await repo.setManualTransfer("saknas", true)).toBe(false);
    expect(await repo.setManualTransfer("borta", true)).toBe(false);
  });

  it("detaljen för en transaktion har kontots namn och motposten för en överföring", async () => {
    const repo = transactionRepository(db);
    await repo.setTransfers([
      { id: "ut", internal: true, pairId: "in" },
      { id: "in", internal: true, pairId: "ut" },
    ]);
    expect(await repo.detail("ut")).toEqual({
      id: "ut",
      accountId: "acc_budget",
      accountName: "Budget",
      accountType: "checking",
      status: "booked",
      transactionDate: "2026-11-02",
      bookingDate: null,
      amountMinor: -500000,
      counterparty: "SPARKONTO",
      counterpartyNorm: "SPARKONTO",
      description: "",
      categoryId: null,
      categorySource: "none",
      isInternalTransfer: true,
      manualTransfer: null,
      transferPair: { id: "in", accountName: "Spar", amountMinor: 500000, transactionDate: "2026-11-02" },
    });
  });

  it("detaljen visar kontots egna namn när det finns, även för motposten (KK-37)", async () => {
    const repo = transactionRepository(db);
    await repo.setTransfers([
      { id: "ut", internal: true, pairId: "in" },
      { id: "in", internal: true, pairId: "ut" },
    ]);
    await db.prepare(`UPDATE accounts SET nickname = 'Buffert' WHERE id = 'acc_spar'`).run();
    expect((await repo.detail("in"))?.accountName).toBe("Buffert");
    expect((await repo.detail("ut"))?.transferPair?.accountName).toBe("Buffert");
    await db.prepare(`UPDATE accounts SET nickname = NULL WHERE id = 'acc_spar'`).run();
  });

  it("detaljen för en preliminär utan motpost, och null för en borttagen eller okänd", async () => {
    const repo = transactionRepository(db);
    await db.prepare(`UPDATE transactions SET status = 'pending' WHERE id = 'kop'`).run();
    expect(await repo.detail("kop")).toMatchObject({ status: "pending", transferPair: null });
    expect(await repo.detail("borta")).toBeNull();
    expect(await repo.detail("saknas")).toBeNull();
  });

  it("ett lånekonto paras som ett sparkonto", async () => {
    await db.prepare(`UPDATE accounts SET type = 'loan' WHERE id = 'acc_spar'`).run();
    expect((await transactionRepository(db).ownAccounts()).find((a) => a.id === "acc_spar")).toEqual({ id: "acc_spar", type: "savings" });
    await db.prepare(`UPDATE accounts SET type = 'savings' WHERE id = 'acc_spar'`).run();
  });

  it("ger de egna kontona med typ utan att behöva nycklar", async () => {
    expect((await transactionRepository(db).ownAccounts()).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "acc_budget", type: "checking" },
      { id: "acc_spar", type: "savings" },
    ]);
  });

  it("listar egna konton med typ för parningen", async () => {
    const keys = await deriveKeys(randomSecret());
    const accounts = (await accountRepository(db, keys).list()).map((a) => [a.id, a.type]).sort();
    expect(accounts).toEqual([
      ["acc_budget", "checking"],
      ["acc_spar", "savings"],
    ]);
  });
});
