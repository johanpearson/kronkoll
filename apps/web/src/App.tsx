// Appens skal (#30): sidorna och huvudmenyn. Menyn har de vyer som finns; Sparmål och Inkomst
// läggs till när de byggs. PWA och offline-cache kommer i egna PR:er.
import { House, PiggyBank, ReceiptText, Settings } from "lucide-react";
import { BudgetView } from "./budget/BudgetView.tsx";
import { ConnectBank, ConnectDone, Consent } from "./connect/ConnectViews.tsx";
import { OverviewView } from "./overview/OverviewView.tsx";
import { Link, usePath } from "./router.tsx";
import { CategoriesView } from "./settings/CategoriesView.tsx";
import { ConnectionView } from "./settings/ConnectionView.tsx";
import { RulesView } from "./settings/RulesView.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { TransactionDetail } from "./transactions/TransactionDetail.tsx";
import { TransactionsView } from "./transactions/TransactionsView.tsx";

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
  "/installningar": SettingsView,
  "/installningar/kategorier": CategoriesView,
  "/installningar/regler": RulesView,
  "/koppla": ConnectBank,
  "/koppla/samtycke": Consent,
  "/koppla/klar": ConnectDone,
};

/** Menyn i den ordning planen har den. Koppla bank hör till Inställningar. */
const TABS = [
  { to: "/", label: "Översikt", Icon: House, owns: (path: string) => path === "/" },
  { to: "/transaktioner", label: "Transaktioner", Icon: ReceiptText, owns: (path: string) => path === "/transaktioner" || path.startsWith("/transaktioner/") },
  { to: "/budget", label: "Budget", Icon: PiggyBank, owns: (path: string) => path === "/budget" },
  { to: "/installningar", label: "Inställningar", Icon: Settings, owns: (path: string) => path === "/installningar" || path.startsWith("/installningar/") || path.startsWith("/koppla") },
];

/** /transaktioner/{id}: detaljsidan för en transaktion. */
const DETAIL = /^\/transaktioner\/([^/]+)$/u;
/** /installningar/koppling/{id}: sidan om en bankkoppling. */
const CONNECTION = /^\/installningar\/koppling\/([^/]+)$/u;

function page(path: string): React.JSX.Element {
  const detailId = DETAIL.exec(path)?.[1];
  if (detailId !== undefined) return <TransactionDetail key={detailId} id={decodeURIComponent(detailId)} />;
  const connectionId = CONNECTION.exec(path)?.[1];
  if (connectionId !== undefined) return <ConnectionView key={connectionId} id={decodeURIComponent(connectionId)} />;
  const Page = ROUTES[path] ?? NotFound;
  return <Page />;
}

export function App() {
  const path = usePath();
  return (
    <>
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
    </>
  );
}
