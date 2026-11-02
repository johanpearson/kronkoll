import type { D1Database } from "@cloudflare/workers-types";
import { CATEGORY_TEMPLATE } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categoryRepository } from "./categories.ts";
import { migratedDb } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
});
afterAll(async () => {
  await dispose();
});

describe("kategorier i D1 (KK-18-A)", () => {
  it("ger startmallens kategorier med förälder, namn, typ och arkivering", async () => {
    const list = await categoryRepository(db).list();
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...list].sort(byId)).toEqual(
      [...CATEGORY_TEMPLATE].map((c) => ({ id: c.id, parentId: c.parentId, name: c.name, kind: c.kind, archived: c.archived })).sort(byId),
    );
  });

  it("tar med arkiverade kategorier, så att äldre transaktioner fortfarande får ett namn", async () => {
    await db.prepare(`UPDATE categories SET archived = 1 WHERE id = 'mat-systembolaget'`).run();
    expect((await categoryRepository(db).list()).find((c) => c.id === "mat-systembolaget")).toMatchObject({ archived: true, name: "Systembolaget" });
  });
});
