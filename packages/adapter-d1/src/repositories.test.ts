import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveKeys, type Keys } from "./crypto.ts";
import { accountRepository, connectionRepository, settingsRepository } from "./repositories.ts";
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
