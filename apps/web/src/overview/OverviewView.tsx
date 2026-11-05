// Översikten (#31, KK-17, KK-7-C, KK-8-A, KK-38): saldo totalt och per konto, periodens in och ut, kvar att spendera, trenden för
// tolv perioder och när synken senast gick, med knappen Synka nu. Utan bank visas en välkomstsida.
// Siffrorna räknas i API:t (GET /api/overview); vyn visar dem bara.
import { formatSek } from "@kronkoll/domain";
import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";
import { IconButton } from "../icon-button.tsx";
import { Link, navigate } from "../router.tsx";
import { SyncButton } from "../sync/SyncButton.tsx";
import { toPeriod, type Period } from "../transactions/TransactionsView.tsx";

/** Varning när samtycket har så här många dagar kvar eller färre (KK-8-A). */
const CONSENT_WARNING_DAYS = 14;

interface TrendPoint {
  readonly period: string;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
}

interface Connection {
  readonly id: string;
  readonly bank: string;
  readonly consentDaysLeft: number | null;
}

interface Account {
  readonly id: string;
  readonly name: string;
  readonly bank: string | null;
  /** Null när banken inte har lämnat något saldo (KK-38-B). */
  readonly balanceMinor: number | null;
}

interface Overview {
  readonly period: Period;
  readonly balanceMinor: number;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly budgetMinor: number;
  readonly leftMinor: number;
  readonly perDayMinor: number | null;
  readonly daysLeft: number;
  readonly lastSyncAt: string | null;
  /** Satt när service workern visar en sparad kopia utan nät (KK-25-B). */
  readonly offlineSavedAt: string | null;
  readonly connections: readonly Connection[];
  readonly accounts: readonly Account[];
  readonly trend: readonly TrendPoint[];
}

const minor = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : 0);
const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);

async function fetchOverview(): Promise<Overview | null> {
  const { status, body } = await getJson("/api/overview");
  const period = toPeriod(field(body, "period"));
  if (status !== 200 || !period) return null;
  const perDay = field(body, "left_per_day_minor");
  const lastSync = field(body, "last_sync_at");
  const offline = field(body, "offline_saved_at");
  return {
    period,
    balanceMinor: minor(field(body, "balance_minor")),
    incomeMinor: minor(field(body, "income_minor")),
    expenseMinor: minor(field(body, "expense_minor")),
    budgetMinor: minor(field(body, "budget_minor")),
    leftMinor: minor(field(body, "left_to_spend_minor")),
    perDayMinor: typeof perDay === "number" ? perDay : null,
    daysLeft: minor(field(body, "days_left")),
    lastSyncAt: typeof lastSync === "string" ? lastSync : null,
    offlineSavedAt: typeof offline === "string" ? offline : null,
    connections: list(field(body, "connections")).map((c) => {
      const days = field(c, "consent_days_left");
      const bank = field(c, "bank");
      const id = field(c, "id");
      return { id: typeof id === "string" ? id : "", bank: typeof bank === "string" ? bank : "Banken", consentDaysLeft: typeof days === "number" ? days : null };
    }),
    accounts: list(field(body, "accounts")).map((a) => {
      const id = field(a, "id");
      const name = field(a, "name");
      const bank = field(a, "bank");
      const balance = field(a, "balance_minor");
      return {
        id: typeof id === "string" ? id : "",
        name: typeof name === "string" ? name : "Konto",
        bank: typeof bank === "string" ? bank : null,
        balanceMinor: Number.isSafeInteger(balance) ? (balance as number) : null,
      };
    }),
    trend: list(field(body, "trend")).map((t) => {
      const period = field(t, "period");
      return { period: typeof period === "string" ? period : "", incomeMinor: minor(field(t, "income_minor")), expenseMinor: minor(field(t, "expense_minor")) };
    }),
  };
}

const syncTime = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
const monthName = new Intl.DateTimeFormat("sv-SE", { month: "long", timeZone: "UTC" });
const monthShort = new Intl.DateTimeFormat("sv-SE", { month: "narrow", timeZone: "UTC" });
const monthOf = (key: string, format: Intl.DateTimeFormat) => format.format(new Date(`${key}-01T00:00:00Z`));

/** In och ut per period som staplar. Samma siffror finns i textform för skärmläsare (KK-17-C). */
function TrendChart({ trend }: { trend: readonly TrendPoint[] }) {
  const max = Math.max(1, ...trend.flatMap((t) => [t.incomeMinor, t.expenseMinor]));
  const height = 80;
  const bar = (value: number) => Math.round((value / max) * height);
  return (
    <figure className="card trend">
      <figcaption>
        In och ut, {trend.length} perioder
        <span className="legend" aria-hidden="true">
          <span className="in">In</span> <span className="out">Ut</span>
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${String(trend.length * 24)} ${String(height + 14)}`} aria-hidden="true">
        {trend.map((t, i) => (
          <g key={t.period} transform={`translate(${String(i * 24)} 0)`}>
            <rect className="in" x="3" y={height - bar(t.incomeMinor)} width="8" height={bar(t.incomeMinor)} rx="2" />
            <rect className="out" x="12" y={height - bar(t.expenseMinor)} width="8" height={bar(t.expenseMinor)} rx="2" />
            <text x="12" y={height + 12} textAnchor="middle">
              {monthOf(t.period, monthShort).toUpperCase()}
            </text>
          </g>
        ))}
      </svg>
      <ul className="visually-hidden">
        {trend.map((t) => (
          <li key={t.period}>
            {monthOf(t.period, monthName)}: in {formatSek(t.incomeMinor)}, ut {formatSek(t.expenseMinor)}
          </li>
        ))}
      </ul>
    </figure>
  );
}

function AccountList({ accounts }: { accounts: readonly Account[] }) {
  return (
    <>
      <h2>Konton</h2>
      <ul aria-label="Konton">
        {accounts.map((a) => (
          <li key={a.id} className="tx">
            <div className="tx-main">
              <span className="tx-name">{a.name}</span>
              <span className="amount">{a.balanceMinor === null ? "Saldo saknas" : formatSek(a.balanceMinor)}</span>
            </div>
            {a.bank !== null && <small className="tx-notes">{a.bank}</small>}
          </li>
        ))}
      </ul>
    </>
  );
}

function SyncRow({ lastSyncAt, onDone }: { lastSyncAt: string | null; onDone: () => void }) {
  return (
    <div className="sync">
      <p>{lastSyncAt === null ? "Inte synkad än" : `Senast synkad ${syncTime.format(new Date(lastSyncAt))}`}</p>
      <SyncButton onDone={onDone} />
    </div>
  );
}

/** Rubriken med kugghjulet till Inställningar, som inte har någon egen flik (planens meny). */
function Header({ title }: { title: string }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      <IconButton label="Inställningar" icon={Settings} onClick={() => { navigate("/installningar"); }} />
    </div>
  );
}

function Welcome() {
  return (
    <main>
      <Header title="Välkommen till Kronkoll" />
      <section className="card">
        <p>Koppla ditt första konto för att se saldo, budget och trender. Kronkoll kan bara läsa, aldrig betala.</p>
        <Link to="/koppla">Koppla bank</Link>
      </section>
    </main>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly overview: Overview };

export function OverviewView() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    void fetchOverview().then((overview) => {
      if (current) setState(overview ? { kind: "ready", overview } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, [reload]);

  if (state.kind === "loading") return <main><Header title="Översikt" /><p>Hämtar…</p></main>;
  if (state.kind === "error") return <main><Header title="Översikt" /><p role="alert">Det gick inte att hämta översikten. Försök igen om en stund.</p></main>;
  const o = state.overview;
  if (o.connections.length === 0) return <Welcome />;

  const used = o.budgetMinor === 0 ? null : Math.round((o.expenseMinor * 100) / o.budgetMinor);
  const expiring = o.connections.filter((c) => c.consentDaysLeft !== null && c.consentDaysLeft <= CONSENT_WARNING_DAYS);
  const withBalance = o.accounts.filter((a) => a.balanceMinor !== null).length;
  const balanceLabel = withBalance === o.accounts.length ? "Saldo" : `Saldo (${String(withBalance)} av ${String(o.accounts.length)} konton)`;

  return (
    <main>
      <Header title="Översikt" />
      <p>{monthOf(o.period.key, monthName).replace(/^./u, (c) => c.toUpperCase())}</p>
      {o.offlineSavedAt && (
        <p className="note" role="note">
          Offline – visar data från {syncTime.format(new Date(o.offlineSavedAt))}.
        </p>
      )}
      <SyncRow lastSyncAt={o.lastSyncAt} onDone={() => { setReload((n) => n + 1); }} />
      {expiring.map((c) => (
        <p key={c.id} role="alert">
          {(c.consentDaysLeft ?? 0) < 0
            ? `Samtycket för ${c.bank} har gått ut, så inget nytt hämtas. `
            : `Kopplingen till ${c.bank} går ut om ${String(c.consentDaysLeft)} dagar. `}
          <Link to={`/installningar/koppling/${encodeURIComponent(c.id)}`}>Förnya med BankID</Link>
        </p>
      ))}
      <section className="card">
        <h2>Kvar att spendera</h2>
        {o.budgetMinor === 0 ? (
          <p>
            Ingen budget för perioden än. <Link to="/budget">Sätt budget</Link>
          </p>
        ) : (
          <>
            <p className={o.leftMinor < 0 ? "big-number over" : "big-number"}>
              {o.leftMinor < 0 ? `Över budget med ${formatSek(-o.leftMinor)}` : formatSek(o.leftMinor)}
            </p>
            {o.perDayMinor !== null && o.leftMinor > 0 && (
              <p>
                ≈ {formatSek(o.perDayMinor)} per dag i {String(o.daysLeft)} dagar
              </p>
            )}
            <progress className="budget-bar" aria-hidden="true" max={o.budgetMinor} value={Math.min(o.expenseMinor, o.budgetMinor)} />
            <small>{String(used)} % av periodens budget är använd</small>
          </>
        )}
      </section>
      <dl className="card stats">
        <div>
          <dt>{balanceLabel}</dt>
          <dd>{formatSek(o.balanceMinor)}</dd>
        </div>
        <div>
          <dt>In</dt>
          <dd>{formatSek(o.incomeMinor)}</dd>
        </div>
        <div>
          <dt>Ut</dt>
          <dd>{formatSek(o.expenseMinor)}</dd>
        </div>
      </dl>
      {o.accounts.length > 0 && <AccountList accounts={o.accounts} />}
      {o.trend.length > 0 && <TrendChart trend={o.trend} />}
      <p>
        <Link to="/insikter">Insikter: avvikelser, återkommande dragningar och största utgifter</Link>
      </p>
    </main>
  );
}
