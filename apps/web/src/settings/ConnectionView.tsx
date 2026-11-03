// En bankkoppling (#34, KK-7-A, KK-8-A): status, hur länge samtycket gäller, kopplingens konton och de
// senaste synkkörningarna med hur det gick. Loggen har bara status, antal och felkod, aldrig bankens
// text (KK-13). Felkoderna översätts till svenska här. Längst ner kan kopplingen raderas (#28, KK-11).
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";
import { Link } from "../router.tsx";
import { SyncButton } from "../sync/SyncButton.tsx";
import { DeleteConnection, type HistoryCounts } from "./DeleteConnection.tsx";

interface Run {
  readonly kind: string;
  readonly status: string;
  readonly startedAt: string;
  readonly newCount: number;
  readonly updatedCount: number;
  readonly errorCode: string | null;
}

interface Account {
  readonly id: string;
  readonly name: string;
  readonly balanceMinor: number | null;
}

interface Connection {
  readonly bank: string;
  readonly consentExpiresOn: string | null;
  readonly consentDaysLeft: number | null;
  readonly failures: number;
  readonly accounts: readonly Account[];
  readonly runs: readonly Run[];
  readonly history: HistoryCounts;
}

const KIND: Record<string, string> = { cron: "Schemalagd", manual: "Manuell", initial: "Första hämtningen", daily: "Daglig" };
const STATUS: Record<string, { text: string; tone: "ok" | "warn" | "bad" }> = {
  ok: { text: "Klar", tone: "ok" },
  partial: { text: "Delvis", tone: "warn" },
  failed: { text: "Misslyckades", tone: "bad" },
  running: { text: "Pågår", tone: "warn" },
};
/** Felkoderna från synken (domain/bank) i klartext. */
const ERROR: Record<string, string> = {
  UNAUTHORIZED: "Banken godkände inte samtycket. Koppla om banken.",
  RATE_LIMITED: "Banken tillät inte fler hämtningar just nu.",
  UNAVAILABLE: "Banken svarade inte.",
  BAD_RESPONSE: "Banken skickade något Kronkoll inte kunde läsa.",
  FAILED: "Något gick fel under hämtningen.",
};

const num = (value: unknown) => (typeof value === "number" ? value : 0);
const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);
const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);

async function fetchConnection(id: string): Promise<Connection | "not_found" | null> {
  const { status, body } = await getJson(`/api/connections/${encodeURIComponent(id)}`);
  if (status === 404) return "not_found";
  if (status !== 200) return null;
  const days = field(body, "consent_days_left");
  return {
    bank: textOrNull(field(body, "bank")) ?? "Banken",
    consentExpiresOn: textOrNull(field(body, "consent_expires_on")),
    consentDaysLeft: typeof days === "number" ? days : null,
    failures: num(field(body, "consecutive_failures")),
    history: { accounts: num(field(field(body, "history"), "accounts")), transactions: num(field(field(body, "history"), "transactions")), splits: num(field(field(body, "history"), "splits")) },
    accounts: list(field(body, "accounts")).map((a) => {
      const balance = field(a, "balance_minor");
      return { id: String(field(a, "id")), name: textOrNull(field(a, "name")) ?? "Konto", balanceMinor: typeof balance === "number" ? balance : null };
    }),
    runs: list(field(body, "sync_runs")).map((r) => ({
      kind: String(field(r, "kind")),
      status: String(field(r, "status")),
      startedAt: String(field(r, "started_at")),
      newCount: num(field(r, "new_count")),
      updatedCount: num(field(r, "updated_count")),
      errorCode: textOrNull(field(r, "error_code")),
    })),
  };
}

const time = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });

function counts(run: Run): string {
  if (run.newCount === 0 && run.updatedCount === 0) return "inget nytt";
  const parts = [
    run.newCount > 0 ? `${String(run.newCount)} ${run.newCount === 1 ? "ny" : "nya"}` : null,
    run.updatedCount > 0 ? `${String(run.updatedCount)} ${run.updatedCount === 1 ? "uppdaterad" : "uppdaterade"}` : null,
  ];
  return parts.filter((p) => p !== null).join(", ");
}

export function ConnectionView({ id }: { id: string }) {
  const [state, setState] = useState<Connection | "not_found" | "error" | null>(null);
  const [reload, setReload] = useState(0);
  const [deleted, setDeleted] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void fetchConnection(id).then((loaded) => {
      if (current) setState(loaded ?? "error");
    });
    return () => {
      current = false;
    };
  }, [id, reload]);

  const back = (
    <p>
      <Link to="/installningar">‹ Inställningar</Link>
    </p>
  );
  if (deleted !== null) {
    return (
      <main>
        {back}
        <h1>Kopplingen är borttagen</h1>
        <p role="status">{deleted}</p>
      </main>
    );
  }
  if (state === null) return <main>{back}<p>Hämtar…</p></main>;
  if (state === "not_found") return <main>{back}<h1>Kopplingen finns inte</h1></main>;
  if (state === "error") return <main>{back}<p role="alert">Det gick inte att hämta kopplingen. Försök igen om en stund.</p></main>;

  const c = state;
  return (
    <main>
      {back}
      <h1>{c.bank}</h1>
      <section className="card">
        {c.consentExpiresOn === null ? (
          <p>Samtycket har inget slutdatum.</p>
        ) : (
          <p>
            Samtycket gäller till {formatDateShort(c.consentExpiresOn)}
            {c.consentDaysLeft !== null && c.consentDaysLeft >= 0 ? ` (${String(c.consentDaysLeft)} dagar kvar)` : ", och har gått ut"}.
          </p>
        )}
        {c.failures > 0 && <p role="alert">De senaste {c.failures} synkarna har misslyckats.</p>}
        <div className="sync">
          <SyncButton onDone={() => { setReload((n) => n + 1); }} />
        </div>
      </section>
      <h2>Konton</h2>
      {c.accounts.length === 0 ? (
        <p>Inga konton.</p>
      ) : (
        <ul aria-label="Konton">
          {c.accounts.map((a) => (
            <li key={a.id} className="tx">
              <div className="tx-main">
                <span className="tx-name">{a.name}</span>
                <span className="amount">{a.balanceMinor === null ? "–" : formatSek(a.balanceMinor)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <h2>Synklogg</h2>
      {c.runs.length === 0 ? (
        <p>Inga synkar än.</p>
      ) : (
        <ul aria-label="Synklogg">
          {c.runs.map((r) => {
            const status = STATUS[r.status] ?? { text: r.status, tone: "warn" as const };
            return (
              <li key={`${r.startedAt}-${r.kind}`} className="tx">
                <div className="tx-main">
                  <span className="tx-name">{time.format(new Date(r.startedAt))}</span>
                  <span className={`badge ${status.tone}`}>{status.text}</span>
                </div>
                <small className="tx-notes">
                  {KIND[r.kind] ?? r.kind} · {counts(r)}
                  {r.errorCode === null ? "" : ` · ${ERROR[r.errorCode] ?? r.errorCode}`}
                </small>
              </li>
            );
          })}
        </ul>
      )}
      <DeleteConnection id={id} bank={c.bank} history={c.history} onDeleted={setDeleted} />
    </main>
  );
}
