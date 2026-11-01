import { describe, expect, it } from "vitest";
import { createLogger, type LogLine } from "./logger.ts";

function capture() {
  const lines: LogLine[] = [];
  return { lines, logger: createLogger((line) => lines.push(line)) };
}

describe("logger med vitlista (KK-13-A)", () => {
  it("skriver vitlistade fält: id, antal, status och tidsåtgång", () => {
    const { lines, logger } = capture();
    logger.info("sync.completed", {
      connection_id: "conn_1",
      accountId: "acc_2",
      new_count: 4,
      updated_count: 2,
      status: "ok",
      duration_ms: 812,
    });
    expect(lines).toEqual([
      {
        level: "info",
        event: "sync.completed",
        fields: { connection_id: "conn_1", accountId: "acc_2", new_count: 4, updated_count: 2, status: "ok", duration_ms: 812 },
      },
    ]);
  });

  it("redigerar bort belopp, motpart, beskrivning och kontonummer", () => {
    const { lines, logger } = capture();
    logger.warn("tx.imported", {
      amount_minor: -41250,
      counterparty: "Fiktiva Livs AB",
      description: "KORTKÖP 1234",
      iban: "SE00 0000 0000 0000 0000 0000",
    });
    expect(lines[0]?.fields).toEqual({
      amount_minor: "[redacted]",
      counterparty: "[redacted]",
      description: "[redacted]",
      iban: "[redacted]",
    });
  });

  it("släpper inte igenom fritext i vitlistade strängfält", () => {
    const { lines, logger } = capture();
    logger.error("sync.failed", { status: "Fiktiva Livs AB köp 412 kr", error_code: "EB_429" });
    expect(lines[0]?.fields).toEqual({ status: "[redacted]", error_code: "EB_429" });
  });

  it("redigerar objekt och listor även under vitlistade nycklar", () => {
    const { lines, logger } = capture();
    logger.info("sync.completed", { status: { nested: "x" }, count: [1, 2] });
    expect(lines[0]?.fields).toEqual({ status: "[redacted]", count: "[redacted]" });
  });

  it("tillåter tal, booleska värden och null under vitlistade nycklar", () => {
    const { lines, logger } = capture();
    logger.info("job.done", { attempt: 2, http_status: 503, kind: "cron", ok_id: null });
    expect(lines[0]?.fields).toEqual({ attempt: 2, http_status: 503, kind: "cron", ok_id: null });
  });

  it("ersätter händelsenamn som inte är en enkel konstant", () => {
    const { lines, logger } = capture();
    logger.info("köp hos Fiktiva Livs AB 412 kr");
    expect(lines[0]).toEqual({ level: "info", event: "invalid_event", fields: {} });
  });
});
