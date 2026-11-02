// Appens skal (#30). Bara sidorna som behövs nu: start och "sidan finns inte". Vyerna för att
// koppla bank (#26) och resten av webbskalet (tema, navigering, PWA, utloggning) kommer i egna PR:er.
import { Link, usePath } from "./router.tsx";

function Start() {
  return (
    <main>
      <h1>Kronkoll</h1>
      <p>Kommer snart.</p>
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

export function App() {
  const path = usePath();
  return path === "/" ? <Start /> : <NotFound />;
}
