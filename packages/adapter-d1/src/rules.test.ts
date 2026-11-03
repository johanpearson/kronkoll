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
