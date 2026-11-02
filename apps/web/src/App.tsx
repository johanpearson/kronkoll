// Appens skal (#30): sidorna och huvudmenyn. Menyn har de vyer som finns; Budget, Sparmål och Inkomst
// läggs till när de byggs. Tema, PWA och offline-cache kommer i egna PR:er.
import { ConnectBank, ConnectDone, Consent } from "./connect/ConnectViews.tsx";
import { Link, usePath } from "./router.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { TransactionsView } from "./transactions/TransactionsView.tsx";

function Overview() {
  return (
    <main>
      <h1>Översikt</h1>
      <p>Översikten kommer snart.</p>
    </main>
  );
}

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
  "/": Overview,
  "/transaktioner": TransactionsView,
  "/installningar": SettingsView,
  "/koppla": ConnectBank,
  "/koppla/samtycke": Consent,
  "/koppla/klar": ConnectDone,
};

/** Menyn i den ordning planen har den. Koppla bank hör till Inställningar. */
const TABS = [
  { to: "/", label: "Översikt", owns: (path: string) => path === "/" },
  { to: "/transaktioner", label: "Transaktioner", owns: (path: string) => path === "/transaktioner" },
  { to: "/installningar", label: "Inställningar", owns: (path: string) => path === "/installningar" || path.startsWith("/koppla") },
];

export function App() {
  const path = usePath();
  const Page = ROUTES[path] ?? NotFound;
  return (
    <>
      <Page />
      <nav className="tabbar" aria-label="Huvudmeny">
        <ul>
          {TABS.map((tab) => (
            <li key={tab.to}>
              <Link to={tab.to} current={tab.owns(path)}>
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
