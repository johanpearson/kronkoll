// Appens skal (#30): sidorna och huvudmenyn. Service workern (sw/) ger offline-skal och senaste
// översikten i högst 24 h.
import { ChevronLeft, House, Landmark, PiggyBank, ReceiptText, RefreshCw, Wallet } from "lucide-react";
import { lazy, Suspense, useEffect, type PointerEvent } from "react";
import { ConnectBank, ConnectDone, Consent } from "./connect/ConnectViews.tsx";
import { PlannerView } from "./planner/PlannerView.tsx";
import { IncomeView } from "./income/IncomeView.tsx";
import { InsightsView } from "./insights/InsightsView.tsx";
import { LoansView } from "./loans/LoansView.tsx";
import { OverviewView } from "./overview/OverviewView.tsx";
import { PULL_TRIGGER_PX } from "./nav/gesture.ts";
import { usePullToSync } from "./nav/usePullToSync.ts";
import { useTabSwipe } from "./nav/useTabSwipe.ts";
import { canGoBack, Link, navigationKind, usePath } from "./router.tsx";
import { CategoriesView } from "./settings/CategoriesView.tsx";
import { ConnectionView } from "./settings/ConnectionView.tsx";
import { RulesView } from "./settings/RulesView.tsx";
import { AccountsSettings, BankSettings, NotificationSettings, PeriodSettings, SettingsView } from "./settings/SettingsView.tsx";
import { TransactionDetail } from "./transactions/TransactionDetail.tsx";
import { TransactionsView } from "./transactions/TransactionsView.tsx";
import { ToastProvider } from "./toast.tsx";
import { IconButton } from "./ui/Button.tsx";

function NotFound() {
  return (
    <main>
      <h1>Sidan finns inte</h1>
      <p>
        <Link to="/">Till start</Link>
      </p>
    </main>
  );
}

const ROUTES: Record<string, () => React.JSX.Element> = {
  "/": OverviewView,
  "/transaktioner": TransactionsView,
  "/budget": PlannerView,
  "/lan": LoansView,
  "/inkomst": IncomeView,
  "/insikter": InsightsView,
  "/installningar": SettingsView,
  "/installningar/kategorier": CategoriesView,
  "/installningar/regler": RulesView,
  "/installningar/konton": AccountsSettings,
  "/installningar/bank": BankSettings,
  "/installningar/budgetperiod": PeriodSettings,
  "/installningar/notiser": NotificationSettings,
  "/koppla": ConnectBank,
  "/koppla/samtycke": Consent,
  "/koppla/klar": ConnectDone,
};

/**
 * Menyn i den ordning planen har den. Insikter, Inställningar och Koppla bank nås från Översikt,
 * så Översikt är markerad där.
 */
const TABS = [
  {
    to: "/",
    label: "Översikt",
    Icon: House,
    owns: (path: string) => path === "/" || path === "/insikter" || path === "/installningar" || path.startsWith("/installningar/") || path.startsWith("/koppla"),
  },
  { to: "/transaktioner", label: "Transaktioner", Icon: ReceiptText, owns: (path: string) => path === "/transaktioner" || path.startsWith("/transaktioner/") },
  { to: "/budget", label: "Budget", Icon: PiggyBank, owns: (path: string) => path === "/budget" || path.startsWith("/budget/") },
  { to: "/lan", label: "Lån", Icon: Landmark, owns: (path: string) => path === "/lan" },
  { to: "/inkomst", label: "Inkomst", Icon: Wallet, owns: (path: string) => path === "/inkomst" || path.startsWith("/inkomst/") },
];

/**
 * Sidor som bara finns i utvecklingsläget (KK-65-E). I produktionsbygget är villkoret falskt redan när
 * Vite bygger, så sidan och dess kod tas bort helt.
 */
const DEV_ROUTES: Record<string, React.LazyExoticComponent<() => React.JSX.Element>> = import.meta.env.DEV
  ? { "/_design": lazy(() => import("./design/DesignPage.tsx")) }
  : {};

/** /transaktioner/{id}: detaljsidan för en transaktion. */
const DETAIL = /^\/transaktioner\/([^/]+)$/u;
/** /installningar/koppling/{id}: sidan om en bankkoppling. */
const CONNECTION = /^\/installningar\/koppling\/([^/]+)$/u;

function page(path: string): React.JSX.Element {
  const detailId = DETAIL.exec(path)?.[1];
  if (detailId !== undefined) return <TransactionDetail key={detailId} id={decodeURIComponent(detailId)} />;
  const connectionId = CONNECTION.exec(path)?.[1];
  if (connectionId !== undefined) return <ConnectionView key={connectionId} id={decodeURIComponent(connectionId)} />;
  const DevPage = DEV_ROUTES[path];
  if (DevPage !== undefined) {
    return (
      <Suspense fallback={null}>
        <DevPage />
      </Suspense>
    );
  }
  const Page = ROUTES[path] ?? NotFound;
  return <Page />;
}

/** Vyerna där man kan dra nedåt för att synka (KK-63-D). */
const PULL_VIEWS = new Set(["/", "/transaktioner"]);

type Handlers = Record<"onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel", (event: PointerEvent<HTMLElement>) => void>;

/** Båda gesterna får varje pekhändelse och avgör själva om den gäller dem. */
const both = (a: Handlers, b: Handlers): Handlers => ({
  onPointerDown: (e) => { a.onPointerDown(e); b.onPointerDown(e); },
  onPointerMove: (e) => { a.onPointerMove(e); b.onPointerMove(e); },
  onPointerUp: (e) => { a.onPointerUp(e); b.onPointerUp(e); },
  onPointerCancel: (e) => { a.onPointerCancel(e); b.onPointerCancel(e); },
});

export function App() {
  const path = usePath();
  const subview = canGoBack();
  // Svep byter flik på flikarnas huvudvyer, inte i undervyer (KK-63-A, B).
  const swipe = useTabSwipe(!subview);
  const pullable = PULL_VIEWS.has(path);
  const pull = usePullToSync(pullable);
  // Webbläsarens egen "dra för att ladda om" stängs av där appen har sin egen (KK-63-E).
  useEffect(() => {
    document.documentElement.classList.toggle("ui-own-pull", pullable);
  }, [pullable]);
  return (
    <ToastProvider>
      {/* En ny vy glider in från höger, bakåt från vänster och ett flikbyte tonar (KK-62-H). */}
      {pull.distance > 0 && (
        <div className="ui-pull" aria-hidden="true" style={{ height: `${String(pull.distance)}px` }}>
          <RefreshCw size={22} strokeWidth={2} className={pull.distance >= PULL_TRIGGER_PX ? "ui-pull-ready" : undefined} />
        </div>
      )}
      <div key={path} className={`ui-view ui-view-${navigationKind()}${subview ? "" : " ui-view-swipe"}`} {...both(swipe, pull.handlers)}>
        {subview && (
          // iOS saknar bakåtknapp, så undervyer har en egen (KK-62-B). Den följer samma steg som telefonens.
          <nav className="ui-backbar" aria-label="Tillbaka">
            <IconButton
              label="Tillbaka"
              icon={ChevronLeft}
              onClick={() => {
                window.history.back();
              }}
            />
          </nav>
        )}
        {page(path)}
      </div>
      <nav className="tabbar" aria-label="Huvudmeny">
        <ul>
          {TABS.map((tab) => (
            <li key={tab.to}>
              <Link to={tab.to} current={tab.owns(path)} tab>
                <tab.Icon aria-hidden="true" size={22} strokeWidth={1.75} />
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </ToastProvider>
  );
}
