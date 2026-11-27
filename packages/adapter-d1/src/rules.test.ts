import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ruleRepository } from "./rules.ts";
import { migratedDb } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
});
afterAll(async () => {
  await dispose();
});

describe("regler i D1 (KK-18)", () => {
  it("ändrar mönster och kategori, även på en mallregel, och säger till när regeln saknas", async () => {
    const repo = ruleRepository(db);
    expect(await repo.update({ id: "mall-ica", pattern: "ICA MAXI", categoryId: "mat-restaurang-cafe" })).toBe(true);
    expect((await repo.list()).find((r) => r.id === "mall-ica")).toEqual({
      id: "mall-ica",
      match: "counterparty_prefix",
      pattern: "ICA MAXI",
      categoryId: "mat-restaurang-cafe",
      source: "template",
    });
    expect(await repo.update({ id: "finns-inte", pattern: "X", categoryId: "mat" })).toBe(false);
  });

  it("byter slag av träff på en kategoriregel och på en Räkna inte-regel, och låter det vara när det inte anges (KK-47)", async () => {
    const repo = ruleRepository(db);
    await repo.save({ id: "r-amazon", match: "counterparty_prefix", pattern: "AMAZON", categoryId: "hushall-forbrukning", source: "learned" });
    expect(await repo.update({ id: "r-amazon", pattern: "AMAZON", categoryId: "hushall-forbrukning", match: "description_contains" })).toBe(true);
    expect((await repo.list()).find((r) => r.id === "r-amazon")?.match).toBe("description_contains");
    expect(await repo.update({ id: "r-amazon", pattern: "AMAZON SE", categoryId: "hushall-forbrukning" })).toBe(true);
    expect((await repo.list()).find((r) => r.id === "r-amazon")).toMatchObject({ match: "description_contains", pattern: "AMAZON SE" });
    await repo.saveExclude({ id: "r-panten", match: "counterparty_prefix", pattern: "PANTEN" });
    expect(await repo.updateExclude({ id: "r-panten", pattern: "PANTEN", match: "description_contains" })).toBe(true);
    expect((await repo.excludeRules()).find((r) => r.id === "r-panten")?.match).toBe("description_contains");
    expect(await repo.updateExclude({ id: "r-panten", pattern: "PANTEN 2" })).toBe(true);
    expect((await repo.excludeRules()).find((r) => r.id === "r-panten")).toMatchObject({ match: "description_contains", pattern: "PANTEN 2" });
    await repo.remove("r-amazon");
    await repo.remove("r-panten");
  });

  it("tar bort en regel, och säger till när den redan är borta", async () => {
    const repo = ruleRepository(db);
    await repo.save({ id: "r-ikea", match: "counterparty_prefix", pattern: "IKEA", categoryId: "hushall-forbrukning", source: "learned" });
    expect(await repo.remove("r-ikea")).toBe(true);
    expect((await repo.list()).some((r) => r.id === "r-ikea")).toBe(false);
    expect(await repo.remove("r-ikea")).toBe(false);
  });
});

describe("regler med åtgärden Räkna inte i D1 (KK-39-C)", () => {
  it("sparas utan kategori, listas för sig och aldrig som kategoriregel", async () => {
    const repo = ruleRepository(db);
    const templates = (await repo.list()).length;
    await repo.saveExclude({ id: "r-mobler", match: "counterparty_prefix", pattern: "PAHITTADE MOBLER" });
    expect(await repo.excludeRules()).toEqual([{ id: "r-mobler", match: "counterparty_prefix", pattern: "PAHITTADE MOBLER" }]);
    expect(await repo.list()).toHaveLength(templates);
  });

  it("hoppar över Räkna inte-regler med en matchning som domänen inte kan än", async () => {
    await db.prepare(`INSERT INTO category_rules (id, match, pattern, source, action) VALUES ('r-belopp', 'amount_range', '100-200', 'learned', 'exclude')`).run();
    expect((await ruleRepository(db).excludeRules()).some((r) => r.id === "r-belopp")).toBe(false);
    await db.prepare(`DELETE FROM category_rules WHERE id = 'r-belopp'`).run();
  });

  it("ändrar mönstret och tar bort regeln som andra regler", async () => {
    const repo = ruleRepository(db);
    await repo.saveExclude({ id: "r-utlagg", match: "counterparty_prefix", pattern: "UTLAGG" });
    expect(await repo.updateExclude({ id: "r-utlagg", pattern: "UTLAGG RESA" })).toBe(true);
    expect((await repo.excludeRules()).find((r) => r.id === "r-utlagg")?.pattern).toBe("UTLAGG RESA");
    expect(await repo.updateExclude({ id: "mall-ica", pattern: "X" })).toBe(false);
    expect(await repo.remove("r-utlagg")).toBe(true);
    expect((await repo.excludeRules()).some((r) => r.id === "r-utlagg")).toBe(false);
  });

  it("databasen tillåter ingen Räkna inte-regel med kategori och ingen kategoriregel utan mål", async () => {
    const insert = (action: string, categoryId: string | null) =>
      db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source, action) VALUES (?, 'counterparty_prefix', 'X', ?, 'learned', ?)`).bind(`r-${action}-${String(categoryId)}`, categoryId, action).run();
    await expect(insert("exclude", "mat")).rejects.toThrow();
    await expect(insert("categorize", null)).rejects.toThrow();
    await expect(insert("hide", null)).rejects.toThrow();
  });
});

describe("ta bort alla regler (KK-51)", () => {
  it("räknar kategoriserande regler och Räkna inte-regler, och tar bort dem men inte inkomstregler", async () => {
    const repo = ruleRepository(db);
    await repo.save({ id: "r-egen", match: "counterparty_prefix", pattern: "IKEA", categoryId: "hushall-forbrukning", source: "learned" });
    await repo.saveExclude({ id: "r-exkl", match: "counterparty_prefix", pattern: "PANTEN" });
    await db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, income_type, source) VALUES ('r-inkomst', 'description_contains', 'BONUS', NULL, 'salary', 'learned')`).run();
    const counts = await repo.countAll();
    expect(counts.exclude).toBeGreaterThanOrEqual(1);
    expect(counts.categorize).toBeGreaterThan(1);
    await repo.removeAll();
    expect(await repo.countAll()).toMatchObject({ categorize: 0, exclude: 0 });
    expect((await db.prepare(`SELECT id FROM category_rules WHERE id = 'r-inkomst'`).first())?.["id"]).toBe("r-inkomst");
    await db.prepare(`DELETE FROM category_rules WHERE id = 'r-inkomst'`).run();
  });
});

describe("ta bort alla regler och kategorierna de satt (KK-51-C)", () => {
  it("rules tömmer det regler satt men inte egna val, och all tömmer allt", async () => {
    await db.batch([
      db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES ('c-regler', 'enablebanking', 'active')`),
      db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('a-regler', 'c-regler', 'Privatkonto', 'checking')`),
      db.prepare(
        `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, category_id, category_source)
         VALUES ('r-mall', 'a-regler', 'fp', 'booked', '2026-11-02', '2026-11-02', -100, 'mat-livsmedel', 'template'),
                ('r-egen', 'a-regler', 'fp', 'booked', '2026-11-02', '2026-11-02', -100, 'mat-livsmedel', 'learned'),
                ('r-manuell', 'a-regler', 'fp', 'booked', '2026-11-02', '2026-11-02', -100, 'mat-livsmedel', 'manual')`,
      ),
    ]);
    const repo = ruleRepository(db);
    expect(await repo.countAll()).toMatchObject({ byRules: 2, all: 3 });
    const categorized = async () => (await db.prepare(`SELECT id FROM transactions WHERE category_id IS NOT NULL AND account_id = 'a-regler' ORDER BY id`).all<{ id: string }>()).results.map((r) => r.id);
    await repo.removeAll("rules");
    expect(await categorized()).toEqual(["r-manuell"]);
    await repo.removeAll("all");
    expect(await categorized()).toEqual([]);
    await db.prepare(`DELETE FROM bank_connections WHERE id = 'c-regler'`).run();
  });
});
