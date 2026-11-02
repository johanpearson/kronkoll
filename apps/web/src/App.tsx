// Appens skal (#30). Sidorna som finns nu: start, koppla bank (#26) och "sidan finns inte".
// Resten av webbskalet (tema, navigering, PWA, utloggning) kommer i egna PR:er.
import { ConnectBank, ConnectDone, Consent } from "./connect/ConnectViews.tsx";
import { Link, usePath } from "./router.tsx";
import { TransactionsView } from "./transactions/TransactionsView.tsx";

function Start() {
  return (
    <main>
      <h1>Kronkoll</h1>
      <p>Kommer snart.</p>
      <p>
        <Link to="/transaktioner">Transaktioner</Link>
      </p>
      <p>
        <Link to="/koppla">Koppla bank</Link>
      </p>
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
  "/": Start,
  "/koppla": ConnectBank,
  "/koppla/samtycke": Consent,
  "/koppla/klar": ConnectDone,
  "/transaktioner": TransactionsView,
};

export function App() {
  const Page = ROUTES[usePath()] ?? NotFound;
  return <Page />;
}
