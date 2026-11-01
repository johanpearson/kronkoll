/**
 * Logger med vitlista (KK-13-A, hot T-I2).
 * Bara id, antal, status, typ, felkoder och tidsåtgång skrivs ut. Allt annat – belopp,
 * motparter, beskrivningar, kontonummer – ersätts med "[redacted]". Händelsenamn måste
 * vara enkla konstanter, så att ingen bankdata kan smita in via meddelandet.
 */

export type LogLevel = "info" | "warn" | "error";
export type LogValue = string | number | boolean | null;

export interface LogLine {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, LogValue>>;
}

export type LogSink = (line: LogLine) => void;

export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

const REDACTED = "[redacted]";
const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;
const ALLOWED_KEYS = new Set([
  "status",
  "kind",
  "count",
  "new_count",
  "updated_count",
  "removed_count",
  "duration_ms",
  "error_code",
  "attempt",
  "http_status",
]);

function isAllowedKey(key: string): boolean {
  return ALLOWED_KEYS.has(key) || key.endsWith("_id") || key.endsWith("Id");
}

function sanitize(key: string, value: unknown): LogValue {
  if (!isAllowedKey(key)) return REDACTED;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string" && SAFE_STRING.test(value)) return value;
  return REDACTED;
}

export function createLogger(sink: LogSink): Logger {
  const write = (level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void => {
    const safe: Record<string, LogValue> = {};
    for (const [key, value] of Object.entries(fields)) {
      safe[key] = sanitize(key, value);
    }
    sink({ level, event: EVENT_NAME.test(event) ? event : "invalid_event", fields: safe });
  };
  return {
    info: (event, fields) => { write("info", event, fields); },
    warn: (event, fields) => { write("warn", event, fields); },
    error: (event, fields) => { write("error", event, fields); },
  };
}
