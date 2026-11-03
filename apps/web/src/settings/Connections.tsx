// Bankkopplingarna i Inställningar (#34, KK-7-A, KK-8-A): en rad per bank med status, antal konton,
// hur länge samtycket gäller och när synken senast lyckades. Ett samtycke som snart går ut och synkar
// som misslyckas i rad står i text, inte bara i färg.
import { formatDateShort } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";
import { Link } from "../router.tsx";

/** Varning när samtycket har så här många dagar kvar eller färre, som på översikten (KK-8-A). */
const CONSENT_WARNING_DAYS = 14;

interface Connection {
  readonly id: string;
  readonly bank: string;
  readonly status: string;
  readonly consentExpiresOn: string | null;
  readonly consentDaysLeft: number | null;
  readonly lastSuccessAt: string | null;
  readonly failures: number;
  readonly accounts: number;
}

const count = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : 0);
const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);

function toConnection(raw: unknown): Connection | null {
  const id = field(raw, "id");
  if (typeof id !== "string") return null;
  const days = field(raw, "consent_days_left");
  return {
    id,
    bank: textOrNull(field(raw, "bank")) ?? "Banken",
    status: textOrNull(field(raw, "status")) ?? "",
    consentExpiresOn: textOrNull(field(raw, "consent_expires_on")),
    consentDaysLeft: typeof days === "number" ? days : null,
    lastSuccessAt: textOrNull(field(raw, "last_success_at")),
    failures: count(field(raw, "consecutive_failures")),
    accounts: count(field(raw, "account_count")),
  };
}

const syncTime = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });

/** Statusen i ord, och om den ska märkas som ett problem. */
function badge(c: Connection): { text: string; tone: "ok" | "warn" | "bad" } {
  if (c.status === "expired" || (c.consentDaysLeft !== null && c.consentDaysLeft < 0)) return { text: "Utgången", tone: "bad" };
  if (c.status === "revoked") return { text: "Återkallad", tone: "bad" };
  if (c.failures > 0) return { text: "Synken misslyckas", tone: "bad" };
  if (c.consentDaysLeft !== null && c.consentDaysLeft <= CONSENT_WARNING_DAYS) return { text: "Går snart ut", tone: "warn" };
  return { text: "Aktiv", tone: "ok" };
}

function details(c: Connection): string[] {
  const accounts = c.accounts === 1 ? "1 konto" : `${String(c.accounts)} konton`;
  const consent = c.consentExpiresOn === null ? null : `samtycke till ${formatDateShort(c.consentExpiresOn)}`;
  const days = c.consentDaysLeft !== null && c.consentDaysLeft >= 0 && c.consentDaysLeft <= CONSENT_WARNING_DAYS ? `${String(c.consentDaysLeft)} dagar kvar` : null;
  const sync = c.lastSuccessAt === null ? "inte synkad än" : `senast synkad ${syncTime.format(new Date(c.lastSuccessAt))}`;
  const failures = c.failures > 0 ? `${String(c.failures)} misslyckade synkar i rad` : null;
  return [accounts, consent, days, sync, failures].filter((s): s is string => s !== null);
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly items: readonly Connection[] };

export function Connections() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void getJson("/api/connections").then(({ status, body }) => {
      if (!current) return;
      const items = field(body, "items");
      setState(status === 200 && Array.isArray(items) ? { kind: "ready", items: items.map(toConnection).filter((c): c is Connection => c !== null) } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, []);

  return (
    <>
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta bankkopplingarna. Försök igen om en stund.</p>}
      {state.kind === "ready" && state.items.length > 0 && (
        <ul aria-label="Bankkopplingar">
          {state.items.map((c) => {
            const b = badge(c);
            return (
              <li key={c.id} className="tx">
                <div className="tx-main">
                  <span className="tx-name">
                    <Link to={`/installningar/koppling/${encodeURIComponent(c.id)}`}>{c.bank}</Link>
                  </span>
                  <span className={`badge ${b.tone}`}>{b.text}</span>
                </div>
                <small className="tx-notes">{details(c).join(" · ")}</small>
              </li>
            );
          })}
        </ul>
      )}
      <p>
        <Link to="/koppla">{state.kind === "ready" && state.items.length > 0 ? "Koppla en till bank" : "Koppla bank"}</Link>
      </p>
    </>
  );
}
