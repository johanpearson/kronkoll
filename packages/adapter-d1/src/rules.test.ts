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
