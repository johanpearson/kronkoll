import type { D1Database } from "@cloudflare/workers-types";
import { TEMPLATE_RULES } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveKeys } from "./crypto.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { ruleRepository } from "./rules.ts";
import { migratedDb, randomSecret } from "./test-support.ts";
import { transactionRepository } from "./transactions.ts";

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

/** Påhittade transaktioner (KK-13): id, normaliserad motpart, status, kategori, källa. */
async function seed(rows: [string, string, "booked" | "pending" | "removed", string | null, "none" | "template" | "learned" | "manual"][]) {
  await db.prepare(`DELETE FROM transactions`).run();
  await db.batch(
    rows.map(([id, norm, status, categoryId, source]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm, description, category_id, category_source)
           VALUES (?, 'acc_1', 'fp', ?, '2026-11-02', '2026-11-02', -100, ?, ?, 'Kortköp', ?, ?)`,
        )
        .bind(id, status, norm, norm, categoryId, source),
    ),
  );
}

describe("regler i D1 (KK-18)", () => {
  beforeEach(async () => {
    await db.prepare(`DELETE FROM category_rules WHERE source = 'learned'`).run();
  });

  it("ger mallreglerna i domänens form", async () => {
    expect([...(await ruleRepository(db).list())].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...TEMPLATE_RULES].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("hoppar över regler som domänen inte kan använda än (beloppsintervall, bara inkomsttyp)", async () => {
    await db.batch([
      db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source) VALUES ('belopp', 'amount_range', '100-200', 'mat-livsmedel', 'learned')`),
      db.prepare(`INSERT INTO category_rules (id, match, pattern, income_type, source) VALUES ('inkomst', 'counterparty_prefix', 'LÖN', 'salary', 'learned')`),
      db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source) VALUES ('lärd', 'counterparty_exact', 'TAKO', 'mat-restaurang-cafe', 'learned')`),
    ]);
    const ids = (await ruleRepository(db).list()).map((r) => r.id);
    expect(ids).toContain("lärd");
    expect(ids).not.toContain("belopp");
    expect(ids).not.toContain("inkomst");
  });
});

describe("okategoriserade transaktioner (KK-18)", () => {
  it("ger bara de som saknar kategori och inte är borttagna", async () => {
    await seed([
      ["t1", "ICA NARA", "booked", null, "none"],
      ["t2", "SL", "pending", null, "none"],
      ["t3", "ICA", "booked", "mat-livsmedel", "template"],
      ["t4", "ICA", "booked", "hushall-forbrukning", "manual"],
      ["t5", "ICA", "removed", null, "none"],
    ]);
    const rows = await transactionRepository(db).uncategorized();
    expect(rows.map((r) => r.id).sort()).toEqual(["t1", "t2"]);
    expect(rows.find((r) => r.id === "t1")).toEqual({ id: "t1", counterpartyNorm: "ICA NARA", description: "Kortköp", categoryId: null, categorySource: "none" });
  });

  it("sparar nya kategorier men skriver aldrig över en manuell (KK-18-C)", async () => {
    await seed([
      ["t1", "ICA NARA", "booked", null, "none"],
      ["t4", "ICA", "booked", "hushall-forbrukning", "manual"],
    ]);
    await transactionRepository(db).setCategories([
      { id: "t1", categoryId: "mat-livsmedel", categorySource: "template" },
      { id: "t4", categoryId: "mat-livsmedel", categorySource: "template" },
    ]);
    const rows = await db.prepare(`SELECT id, category_id AS c, category_source AS s FROM transactions ORDER BY id`).all();
    expect(rows.results).toEqual([
      { id: "t1", c: "mat-livsmedel", s: "template" },
      { id: "t4", c: "hushall-forbrukning", s: "manual" },
    ]);
  });

  it("gör ingenting med en tom lista", async () => {
    await expect(transactionRepository(db).setCategories([])).resolves.toBeUndefined();
  });
});
