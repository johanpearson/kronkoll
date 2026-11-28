// Inställningar (#259, KK-62-B, KK-65-A): grupperade listrader med ikon och chevron som leder till varsin
// undervy, utseendet direkt på sidan och Logga ut som en tydlig knapp längst ned (KK-35-A). Undervyerna har
// sina egna sidor nedan, så att bakåt går tillbaka hit.
import { Bell, CalendarDays, Info, Landmark, ListChecks, Tag, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { browser } from "../browser.ts";
import { setTheme, storedTheme, type Theme } from "../theme.ts";
import { Button } from "../ui/Button.tsx";
import { List, ListRow } from "../ui/ListRow.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Card } from "../ui/Surface.tsx";
import { AccountNames } from "./AccountNames.tsx";
import { Connections } from "./Connections.tsx";
import { Notifications } from "./Notifications.tsx";
import { PeriodStart } from "./PeriodStart.tsx";

/** Cloudflare Access utloggning på samma adress som appen. */
const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Ljust" },
  { value: "dark", label: "Mörkt" },
];

export function SettingsView() {
  const [busy, setBusy] = useState(false);
  const [theme, setChosen] = useState<Theme>(storedTheme);

  const logOut = async () => {
    setBusy(true);
    await browser.clearDevice();
    browser.assign(ACCESS_LOGOUT);
  };

  const choose = (value: Theme) => {
    setTheme(value);
    setChosen(value);
  };

  return (
    <main>
      <h1>Inställningar</h1>
      <List label="Konton och bank">
        <ListRow icon={Wallet} label="Konton" detail="Roller och egna namn" to="/installningar/konton" />
        <ListRow icon={Landmark} label="Bank" detail="Kopplingar och samtycke" to="/installningar/bank" />
      </List>
      <List label="Budget">
        <ListRow icon={Tag} label="Kategorier" to="/installningar/kategorier" />
        <ListRow icon={ListChecks} label="Regler" to="/installningar/regler" />
        <ListRow icon={CalendarDays} label="Budgetperiod" detail="Vilken dag perioden börjar" to="/installningar/budgetperiod" />
      </List>
      <List label="Appen">
        <ListRow icon={Bell} label="Notiser" to="/installningar/notiser" />
        <ListRow icon={Info} label="Om appen" detail="Version och integritet" to="/installningar/om" />
      </List>
      <Card title="Utseende">
        <SegmentedControl label="Utseende" options={THEMES} value={theme} onChange={choose} />
      </Card>
      <Card>
        <p className="ui-body">Utloggningen tar bort allt Kronkoll har sparat i webbläsaren och avslutar inloggningen.</p>
        <Button variant="danger" block busy={busy} onClick={() => void logOut()}>
          {busy ? "Loggar ut…" : "Logga ut och rensa enheten"}
        </Button>
      </Card>
    </main>
  );
}

function Page(props: { title: string; children: ReactNode }) {
  return (
    <main>
      <h1>{props.title}</h1>
      {props.children}
    </main>
  );
}

/** /installningar/konton: roller (KK-53) och egna namn (KK-37). */
export function AccountsSettings() {
  return (
    <Page title="Konton">
      <AccountNames />
    </Page>
  );
}

/** /installningar/bank: kopplingarna, att koppla en bank och samtycket (KK-8, KK-11). */
export function BankSettings() {
  return (
    <Page title="Bank">
      <Connections />
    </Page>
  );
}

/** /installningar/budgetperiod: start på lönedagen (KK-34). */
export function PeriodSettings() {
  return (
    <Page title="Budgetperiod">
      <Card>
        <PeriodStart />
      </Card>
    </Page>
  );
}

/** /installningar/notiser: push (KK-27). */
export function NotificationSettings() {
  return (
    <Page title="Notiser">
      <Card>
        <Notifications />
      </Card>
    </Page>
  );
}

/** Versionen: commit som bygget gjordes från, satt av vite.config.ts. Lokalt finns ingen. */
const VERSION: string = typeof import.meta.env.VITE_COMMIT === "string" && import.meta.env.VITE_COMMIT !== "" ? import.meta.env.VITE_COMMIT.slice(0, 7) : "Utvecklingsversion";

/** /installningar/om: version, integritet och villkor (#259). */
export function AboutSettings() {
  return (
    <Page title="Om appen">
      <Card title="Version">
        <p className="ui-body">{VERSION}</p>
      </Card>
      <Card title="Integritet">
        <ul className="ui-body ui-stack">
          <li>Kronkoll har bara läsbehörighet hos banken. Appen kan inte göra betalningar eller ändra något hos banken.</li>
          <li>Bankdata hämtas via Enable Banking och sparas i appens egen databas hos Cloudflare. Den delas inte med någon annan.</li>
          <li>Appen går bara att nå för inbjudna, efter inloggning med Cloudflare Access.</li>
          <li>Loggarna innehåller aldrig bankens texter, bara status, antal och felkoder.</li>
          <li>En bankkoppling kan raderas med sin historik under Bank.</li>
        </ul>
      </Card>
      <Card title="Villkor">
        <p className="ui-body">Kronkoll är en personlig app. Det finns inga villkor utöver det samtycke du ger banken när du kopplar den.</p>
      </Card>
    </Page>
  );
}
