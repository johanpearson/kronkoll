// Sidan /_design (KK-65-E): designsystemets grund på ett ställe, så att ägaren kan granska den i ljust och
// mörkt läge innan vyerna byggs om. Finns bara i utvecklingsläget (se DEV_ROUTES i App.tsx).
// Färgerna läses direkt ur tokens.css, så att en ny token syns här utan att någon behöver lägga till den.
import { formatSek } from "@kronkoll/domain";
import { Landmark, Plus, Trash2, Wallet } from "lucide-react";
import { useState } from "react";
import css from "../styles/tokens.css?raw";
import { setTheme, storedTheme, type Theme } from "../theme.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { AmountInput } from "../ui/AmountInput.tsx";
import { Chip } from "../ui/Chip.tsx";
import { List, ListRow } from "../ui/ListRow.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Switch } from "../ui/Switch.tsx";
import "./design.css";

const LIGHT = css.slice(css.indexOf(":root {"), css.indexOf("}"));
const COLORS = [...LIGHT.matchAll(/--([a-z-]+):\s*#[0-9a-fA-F]{6}\s*;/gu)].map((m) => m[1] ?? "");

const THEMES: readonly [Theme, string][] = [
  ["light", "Ljust"],
  ["dark", "Mörkt"],
  ["system", "System"],
];

const TYPE: readonly [string, string][] = [
  ["ui-title", "Rubrik för en vy"],
  ["ui-heading", "Rubrik för ett kort"],
  ["ui-body", "Brödtext som förklarar något i en mening eller två."],
  ["ui-label", "Etikett"],
  ["ui-caption", "Liten text, t.ex. datum"],
];

const PERIODS = [
  { value: "month", label: "Månad" },
  { value: "year", label: "År" },
  { value: "all", label: "Allt" },
] as const;

const SPACES = [1, 2, 3, 4, 5, 6, 7];
const RADII = ["radius-xs", "radius-small", "radius", "radius-large", "radius-pill"];
const SHADOWS = ["shadow-sm", "shadow", "shadow-lg"];

export default function DesignPage() {
  const [theme, setChosen] = useState(storedTheme);
  const [replay, setReplay] = useState(0);
  const [notify, setNotify] = useState(true);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["value"]>("month");
  const [budget, setBudget] = useState("1 250,50");
  const choose = (next: Theme) => {
    setTheme(next);
    setChosen(next);
  };

  return (
    <main className="design">
      <h1>Designsystem</h1>
      <p className="ui-body">Grunden för den nya appen (KK-65). Byt läge för att se båda.</p>
      <div className="design-themes" role="group" aria-label="Läge">
        {THEMES.map(([value, label]) => (
          <button key={value} type="button" aria-pressed={theme === value} onClick={() => { choose(value); }}>
            {label}
          </button>
        ))}
      </div>

      <h2>Knappar</h2>
      <section className="design-panel ui-stack">
        <Button variant="primary" icon={Plus}>
          Primär
        </Button>
        <Button>Sekundär</Button>
        <Button variant="quiet">Tyst</Button>
        <Button variant="danger">Fara</Button>
        <Button variant="primary" busy>
          Upptagen
        </Button>
        <div className="design-row">
          <IconButton label="Lägg till" icon={Plus} />
          <IconButton label="Ta bort" icon={Trash2} danger />
        </div>
      </section>

      <h2>Formulär</h2>
      <section className="design-panel ui-stack">
        <SegmentedControl label="Period" options={PERIODS} value={period} onChange={setPeriod} />
        <Switch checked={notify} onChange={setNotify}>
          Notiser om stora köp
        </Switch>
        <AmountInput label="Budget för Mat" value={budget} hint="Lämna tomt för ingen budget." onChange={setBudget} />
        <AmountInput label="Ett felaktigt belopp" value="tolv" onChange={() => undefined} />
      </section>

      <h2>Etiketter</h2>
      <section className="design-panel design-row">
        <Chip>Neutral</Chip>
        <Chip tone="primary">Buffert</Chip>
        <Chip tone="success">Inkomst</Chip>
        <Chip tone="warning">Preliminär</Chip>
        <Chip tone="danger">Över budget</Chip>
      </section>

      <h2>Listrader</h2>
      <List label="Exempelrader">
        <ListRow icon={Wallet} label="Gemensamt" detail="Inkomst/Utgift" value={formatSek(1_230_000)} />
        <ListRow icon={Landmark} label="Bolån" detail="Visar lånet" to="/_design" />
        <ListRow label="Tema" value="System" onClick={() => undefined} />
        <ListRow label="Ta bort koppling" danger onClick={() => undefined} />
      </List>

      <h2>Färger</h2>
      <ul className="design-swatches">
        {COLORS.map((name) => (
          <li key={name}>
            <span className="design-swatch" style={{ background: `var(--${name})` }} aria-hidden="true" />
            <code>--{name}</code>
          </li>
        ))}
      </ul>

      <h2>Typografi</h2>
      <section className="design-panel ui-stack">
        <p className="ui-label">Saldo</p>
        <p className="ui-display ui-amount">{formatSek(1_234_567)}</p>
        {TYPE.map(([className, text]) => (
          <p key={className} className={className}>
            {text} <code>.{className}</code>
          </p>
        ))}
        <p className="ui-body ui-amount ui-amount-positive">+{formatSek(4_250_000)}</p>
      </section>

      <h2>Avstånd</h2>
      <section className="design-panel ui-stack">
        {SPACES.map((n) => (
          <div key={n} className="design-row">
            <span className="design-space" style={{ width: `var(--space-${String(n)})` }} aria-hidden="true" />
            <code>--space-{n}</code>
          </div>
        ))}
      </section>

      <h2>Radier</h2>
      <section className="design-grid">
        {RADII.map((name) => (
          <div key={name} className="design-box" style={{ borderRadius: `var(--${name})` }}>
            <code>--{name}</code>
          </div>
        ))}
      </section>

      <h2>Skuggor</h2>
      <section className="design-grid">
        {SHADOWS.map((name) => (
          <div key={name} className="design-box" style={{ boxShadow: `var(--${name})` }}>
            <code>--{name}</code>
          </div>
        ))}
      </section>

      <h2>Rörelse</h2>
      <section className="design-panel ui-stack">
        <p className="ui-body">Vyer och kort tonar in och glider upp på 250 ms. Inget rör sig vid minskad rörelse.</p>
        <div key={replay} data-testid="motion-demo" className="design-box ui-enter">
          <code>.ui-enter</code>
        </div>
        <button type="button" onClick={() => { setReplay((n) => n + 1); }}>
          Spela upp
        </button>
      </section>
    </main>
  );
}
