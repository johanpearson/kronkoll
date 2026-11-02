import type { D1Database } from "@cloudflare/workers-types";
import type { BalanceStore, ConnectionSyncState, SyncRunLog, SyncRunSummary, TransactionStore } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveKeys, type Keys } from "./crypto.ts";
import { accountRepository, connectionRepository, settingsRepository, syncRunRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";
import { transactionRepository } from "./transactions.ts";

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

let seq = 0;
const newId = () => `id-${String(++seq)}`;

// Påhittade värden, formade som Enable Bankings (KK-13).
const SESSION_ID = "3f1d2c4b-0000-4000-8000-00000000abcd";
const IBAN = "SE45 5000 0000 0583 9825 7466";

describe("inställningar", () => {
  it("läser standardvärdena och sparar en ny startdag", async () => {
    const repo = settingsRepository(db);
    expect(await repo.get()).toEqual({ budgetPeriodStartDay: 1, timezone: "Europe/Stockholm" });
    await repo.setBudgetPeriodStartDay(25);
    expect((await repo.get()).budgetPeriodStartDay).toBe(25);
    await expect(repo.setBudgetPeriodStartDay(29)).rejects.toThrow(RangeError);
  });

  it("säger tydligt till om inställningsraden saknas", async () => {
    await db.prepare(`DELETE FROM settings`).run();
    await expect(settingsRepository(db).get()).rejects.toThrow(/migreringarna/u);
    await db.prepare(`INSERT INTO settings (id) VALUES ('settings')`).run();
  });
});

describe("bankkopplingar", () => {
  it("sparar session-id krypterat och ger tillbaka det i klartext bara via repositoryt", async () => {
    const repo = connectionRepository(db, keys);
    await repo.create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
    expect(await repo.sessionId("c1")).toBeNull();
    await repo.activate("c1", { sessionId: SESSION_ID, consentExpiresOn: "2027-04-30" });
    expect(await repo.sessionId("c1")).toBe(SESSION_ID);
    expect(await repo.get("c1")).toEqual({ id: "c1", provider: "enablebanking", aspspName: "Skandia", status: "active", consentExpiresOn: "2027-04-30" });
  });

  it("byter status, listar och raderar", async () => {
    const repo = connectionRepository(db, keys);
    await repo.create({ id: "c2", provider: "csv", aspspName: null });
    await repo.setStatus("c2", "expired");
    expect((await repo.list()).find((c) => c.id === "c2")?.status).toBe("expired");
    await repo.delete("c2");
    expect(await repo.get("c2")).toBeNull();
  });
});

describe("konton", () => {
  it("sparar ett maskerat namn och IBAN som hash, och uppdaterar samma konto vid nästa synk", async () => {
    const repo = accountRepository(db, keys);
    const input = { connectionId: "c1", providerUid: "acc-1", iban: IBAN, name: "Privatkonto", type: "checking" as const, balanceMinor: 1250050 };
    const id = await repo.upsertFromBank(input, newId);
    expect(await repo.upsertFromBank({ ...input, balanceMinor: 990000 }, newId)).toBe(id);
    const [row] = (await repo.list()).filter((a) => a.id === id);
    expect(row).toMatchObject({ displayName: "Privatkonto ••7466", balanceMinor: 990000, included: true });
    expect(row?.ibanHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("känner igen kontot på IBAN efter koppla om, så att historiken följer med (KK-8-B)", async () => {
    const connections = connectionRepository(db, keys);
    const repo = accountRepository(db, keys);
    await connections.create({ id: "c3", provider: "enablebanking", aspspName: "Skandia" });
    const before = (await repo.list()).find((a) => a.providerUid === "acc-1");
    const id = await repo.upsertFromBank({ connectionId: "c3", providerUid: "ny-uid", iban: IBAN, name: "Privatkonto", type: "checking", balanceMinor: 0 }, newId);
    expect(id).toBe(before?.id);
    expect((await repo.list()).find((a) => a.id === id)).toMatchObject({ connectionId: "c3", providerUid: "ny-uid" });
  });

  it("ett konto utan IBAN, t.ex. ett kort, blir ett nytt konto", async () => {
    const repo = accountRepository(db, keys);
    const id = await repo.upsertFromBank({ connectionId: "c3", providerUid: "card-1", iban: null, name: "Visa", type: "credit_card", balanceMinor: -320000 }, newId);
    expect((await repo.list()).find((a) => a.id === id)).toMatchObject({ displayName: "Visa", ibanHash: null });
  });
});

describe("synkens portar (KK-7, KK-14)", () => {
  it("repositories uppfyller domänens portar, så att synken kan kopplas in utan omskrivning", () => {
    // Kontrolleras av typkontrollen: tilldelningarna kompilerar bara om formerna stämmer.
    const runs: SyncRunLog = syncRunRepository(db);
    const connections: ConnectionSyncState = connectionRepository(db, keys);
    const balances: BalanceStore = accountRepository(db, keys);
    const store: TransactionStore = transactionRepository(db);
    expect([runs, connections, balances, store]).toHaveLength(4);
  });

  it("sätter ett kontos saldo, och kastar för ett konto som inte finns", async () => {
    const accounts = accountRepository(db, keys);
    const id = await accounts.upsertFromBank({ connectionId: "c1", providerUid: "saldo-1", iban: null, name: "Sparkonto", type: "savings", balanceMinor: null }, newId);
    await accounts.setBalance(id, 4_250_075);
    expect((await accounts.list()).find((a) => a.id === id)?.balanceMinor).toBe(4_250_075);
    await accounts.setBalance(id, -1200);
    expect((await accounts.list()).find((a) => a.id === id)?.balanceMinor).toBe(-1200);
    await expect(accounts.setBalance("saknas", 1)).rejects.toThrow();
  });

  it("avvisar ett saldo som inte är heltal öre", async () => {
    const accounts = accountRepository(db, keys);
    const [first] = await accounts.list();
    await expect(accounts.setBalance(first?.id ?? "", 12.5)).rejects.toThrow(RangeError);
  });

  it("listar en kopplings konton med bankens id, utan manuella konton", async () => {
    const connections = connectionRepository(db, keys);
    await connections.create({ id: "c7", provider: "enablebanking", aspspName: "Skandia" });
    const accounts = accountRepository(db, keys);
    const a = await accounts.upsertFromBank({ connectionId: "c7", providerUid: "u-a", iban: null, name: "A", type: "checking", balanceMinor: 0 }, newId);
    await db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('manuellt', 'c7', 'Kontant', 'manual')`).run();
    expect(await accounts.listForConnection("c7")).toEqual([{ id: a, providerUid: "u-a" }]);
    expect(await accounts.listForConnection("ingen")).toEqual([]);
  });

  it("sätter en koppling till utgången", async () => {
    const connections = connectionRepository(db, keys);
    await connections.create({ id: "c8", provider: "enablebanking", aspspName: "Skandia" });
    await connections.activate("c8", { sessionId: SESSION_ID, consentExpiresOn: "2027-04-30" });
    await connections.expire("c8");
    expect((await connections.get("c8"))?.status).toBe("expired");
    await expect(connections.expire("saknas")).rejects.toThrow();
  });
});

describe("körningslogg (KK-7-A, KK-7-B)", () => {
  const summary = (overrides: Partial<SyncRunSummary> = {}): SyncRunSummary => ({
    status: "ok",
    newCount: 0,
    updatedCount: 0,
    errorCode: null,
    ...overrides,
  });

  it("sparar en körning som pågående och sedan resultatet utan bankdata", async () => {
    const repo = syncRunRepository(db);
    await repo.start({ id: "run-1", connectionId: "c1", kind: "cron", startedAt: "2026-11-02T04:07:00.000Z" });
    expect(await repo.get("run-1")).toMatchObject({ status: "running", finishedAt: null, newCount: 0, errorCode: null });

    await repo.finish("run-1", "2026-11-02T04:07:03.000Z", summary({ status: "partial", newCount: 4, updatedCount: 2, errorCode: "EB_429" }));
    expect(await repo.get("run-1")).toEqual({
      id: "run-1",
      connectionId: "c1",
      kind: "cron",
      startedAt: "2026-11-02T04:07:00.000Z",
      finishedAt: "2026-11-02T04:07:03.000Z",
      status: "partial",
      newCount: 4,
      updatedCount: 2,
      errorCode: "EB_429",
    });
  });

  it("returnerar null för en körning som inte finns", async () => {
    expect(await syncRunRepository(db).get("saknas")).toBeNull();
  });

  it("avvisar en felkod som kan innehålla bankens text", async () => {
    const repo = syncRunRepository(db);
    await repo.start({ id: "run-2", connectionId: "c1", kind: "cron", startedAt: "2026-11-02T04:07:00.000Z" });
    await expect(repo.finish("run-2", "2026-11-02T04:07:01.000Z", summary({ status: "failed", errorCode: "Bank says: no" }))).rejects.toThrow();
  });

  it("ger starttiden för senaste manuella körningen, och null när ingen finns", async () => {
    const repo = syncRunRepository(db);
    expect(await repo.lastManualStartedAt()).toBeNull();
    await repo.start({ id: "run-m1", connectionId: "c1", kind: "manual", startedAt: "2026-11-02T08:00:00.000Z" });
    await repo.start({ id: "run-m2", connectionId: "c1", kind: "manual", startedAt: "2026-11-02T09:30:00.000Z" });
    await repo.start({ id: "run-c3", connectionId: "c1", kind: "cron", startedAt: "2026-11-02T15:07:00.000Z" });
    expect(await repo.lastManualStartedAt()).toEqual(new Date("2026-11-02T09:30:00.000Z"));
  });
});

describe("kopplingens synkstatus (KK-7-A, KK-7-B)", () => {
  async function failureCount(id: string) {
    const row = await db.prepare(`SELECT consecutive_failures AS n, last_success_at AS at FROM bank_connections WHERE id = ?`).bind(id).first<{ n: number; at: string | null }>();
    return row;
  }

  it("sparar tidpunkten för senaste lyckade synk och nollställer felräknaren", async () => {
    const repo = connectionRepository(db, keys);
    await repo.create({ id: "c4", provider: "enablebanking", aspspName: "Skandia" });
    expect(await repo.recordSyncOutcome("c4", "failed", "2026-11-02T04:07:00.000Z")).toBe(1);
    expect(await repo.recordSyncOutcome("c4", "ok", "2026-11-02T15:07:00.000Z")).toBe(0);
    expect(await failureCount("c4")).toEqual({ n: 0, at: "2026-11-02T15:07:00.000Z" });
  });

  it("räknar misslyckade körningar i rad utan att röra senaste lyckade tidpunkt", async () => {
    const repo = connectionRepository(db, keys);
    await repo.create({ id: "c5", provider: "enablebanking", aspspName: "Skandia" });
    await repo.recordSyncOutcome("c5", "ok", "2026-11-01T15:07:00.000Z");
    await repo.recordSyncOutcome("c5", "failed", "2026-11-02T04:07:00.000Z");
    expect(await repo.recordSyncOutcome("c5", "failed", "2026-11-02T15:07:00.000Z")).toBe(2);
    expect(await failureCount("c5")).toEqual({ n: 2, at: "2026-11-01T15:07:00.000Z" });
  });

  it("en delvis lyckad körning nollställer felräknaren men räknas inte som lyckad synk", async () => {
    const repo = connectionRepository(db, keys);
    await repo.create({ id: "c6", provider: "enablebanking", aspspName: "Skandia" });
    await repo.recordSyncOutcome("c6", "failed", "2026-11-02T04:07:00.000Z");
    expect(await repo.recordSyncOutcome("c6", "partial", "2026-11-02T15:07:00.000Z")).toBe(0);
    expect(await failureCount("c6")).toEqual({ n: 0, at: null });
  });

  it("kastar för en koppling som inte finns", async () => {
    await expect(connectionRepository(db, keys).recordSyncOutcome("saknas", "ok", "2026-11-02T04:07:00.000Z")).rejects.toThrow();
  });
});

describe("lagringsminimering (KK-11-C, V-i-storage)", () => {
  it("efter en koppling finns varken session-id, IBAN eller kontonummer i klartext någonstans i databasen", async () => {
    const tables = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND name NOT LIKE '\\_%' ESCAPE '\\'`).all<{ name: string }>();
    const dump: string[] = [];
    for (const { name } of tables.results) {
      const rows = await db.prepare(`SELECT * FROM "${name}"`).all();
      dump.push(JSON.stringify(rows.results));
      const blobs = await db.prepare(`SELECT name FROM pragma_table_info(?) WHERE lower(type) = 'blob'`).bind(name).all<{ name: string }>();
      for (const column of blobs.results) {
        const values = await db.prepare(`SELECT CAST("${column.name}" AS TEXT) AS v FROM "${name}"`).all<{ v: string | null }>();
        dump.push(values.results.map((r) => r.v ?? "").join("\n"));
      }
    }
    const everything = dump.join("\n");
    expect(everything).toContain("Privatkonto ••7466");
    for (const secret of [SESSION_ID, IBAN, IBAN.replace(/\s/gu, ""), "58398257466"]) expect(everything).not.toContain(secret);
  });
});
