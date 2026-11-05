// Appens skal (#30): sidorna och huvudmenyn. Service workern (sw/) ger offline-skal och senaste
// översikten i högst 24 h.
import { Goal, House, PiggyBank, ReceiptText, Wallet } from "lucide-react";
import { BudgetView } from "./budget/BudgetView.tsx";
import { ConnectBank, ConnectDone, Consent } from "./connect/ConnectViews.tsx";
import { GoalDetail } from "./goals/GoalDetail.tsx";
import { GoalsView } from "./goals/GoalsView.tsx";
import { NewGoal } from "./goals/NewGoal.tsx";
import { IncomeView } from "./income/IncomeView.tsx";
import { LoansView } from "./loans/LoansView.tsx";
import { NewLeave } from "./income/NewLeave.tsx";
import { OverviewView } from "./overview/OverviewView.tsx";
import { Link, usePath } from "./router.tsx";
import { CategoriesView } from "./settings/CategoriesView.tsx";
import { ConnectionView } from "./settings/ConnectionView.tsx";
import { RulesView } from "./settings/RulesView.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { TransactionDetail } from "./transactions/TransactionDetail.tsx";
import { TransactionsView } from "./transactions/TransactionsView.tsx";
import { ToastProvider } from "./toast.tsx";

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
  "/budget": BudgetView,
  "/sparmal": GoalsView,
  "/sparmal/nytt": NewGoal,
  "/sparmal/lan": LoansView,
  "/inkomst": IncomeView,
  "/inkomst/ledighet": NewLeave,
  "/installningar": SettingsView,
  "/installningar/kategorier": CategoriesView,
  "/installningar/regler": RulesView,
  "/koppla": ConnectBank,
  "/koppla/samtycke": Consent,
  "/koppla/klar": ConnectDone,
};

/**
 * Menyn i den ordning planen har den. Inställningar och Koppla bank nås från Översikt (kugghjulet),
 * så Översikt är markerad där.
 */
const TABS = [
  {
    to: "/",
    label: "Översikt",
    Icon: House,
    owns: (path: string) => path === "/" || path === "/installningar" || path.startsWith("/installningar/") || path.startsWith("/koppla"),
  },
  { to: "/transaktioner", label: "Transaktioner", Icon: ReceiptText, owns: (path: string) => path === "/transaktioner" || path.startsWith("/transaktioner/") },
  { to: "/budget", label: "Budget", Icon: PiggyBank, owns: (path: string) => path === "/budget" },
  { to: "/sparmal", label: "Sparmål", Icon: Goal, owns: (path: string) => path === "/sparmal" || path.startsWith("/sparmal/") },
  { to: "/inkomst", label: "Inkomst", Icon: Wallet, owns: (path: string) => path === "/inkomst" || path.startsWith("/inkomst/") },
];

/** /transaktioner/{id}: detaljsidan för en transaktion. */
const DETAIL = /^\/transaktioner\/([^/]+)$/u;
/** /installningar/koppling/{id}: sidan om en bankkoppling. */
const CONNECTION = /^\/installningar\/koppling\/([^/]+)$/u;
/** /sparmal/{id}: sidan för ett sparmål. /sparmal/nytt är formuläret och /sparmal/lan lånen. */
const GOAL = /^\/sparmal\/(?!(?:nytt|lan)$)([^/]+)$/u;

function page(path: string): React.JSX.Element {
  const detailId = DETAIL.exec(path)?.[1];
  if (detailId !== undefined) return <TransactionDetail key={detailId} id={decodeURIComponent(detailId)} />;
  const connectionId = CONNECTION.exec(path)?.[1];
  if (connectionId !== undefined) return <ConnectionView key={connectionId} id={decodeURIComponent(connectionId)} />;
  const goalId = GOAL.exec(path)?.[1];
  if (goalId !== undefined) return <GoalDetail key={goalId} id={decodeURIComponent(goalId)} />;
  const Page = ROUTES[path] ?? NotFound;
  return <Page />;
}

export function App() {
  const path = usePath();
  return (
    <ToastProvider>
      {page(path)}
      <nav className="tabbar" aria-label="Huvudmeny">
        <ul>
          {TABS.map((tab) => (
            <li key={tab.to}>
              <Link to={tab.to} current={tab.owns(path)}>
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
