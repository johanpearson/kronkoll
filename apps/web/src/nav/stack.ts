// Historiken som i en app (KK-62). Appen håller webbläsarens historik kort och förutsägbar: Översikt
// är alltid första steget, en annan flik ligger ovanpå den och undervyer ovanpå sin flik. Bakåt följer
// därför flikarnas logik, och från Översikt stänger bakåt appen. Ren logik utan DOM.

/** Flikarna i menyn, utom Översikt som är "/". */
const TABS = ["/transaktioner", "/budget", "/lan", "/inkomst"] as const;

export type Tab = "/" | (typeof TABS)[number];

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Fliken som en adress hör till. Inställningar, Insikter och bankkopplingen nås från Översikt. */
export function tabOf(path: string): Tab {
  return TABS.find((tab) => under(path, tab)) ?? "/";
}

/** Vyn som en adress öppnas från om man kommer dit direkt, t.ex. via en djuplänk. */
function parentOf(path: string): string | null {
  if (path === "/") return null;
  const tab = tabOf(path);
  if (tab !== "/") return path === tab ? "/" : tab;
  if (under(path, "/installningar")) return path === "/installningar" ? "/" : "/installningar";
  // Bankkopplingen startar från Inställningar. Klar-sidan leder inte tillbaka in i flödet.
  if (path === "/koppla" || path === "/koppla/klar") return "/installningar";
  if (under(path, "/koppla")) return "/koppla";
  return "/";
}

/** Stegen bakåt för en adress, från Översikt till adressen själv (KK-62-B, C, D och G). */
export function canonicalStack(path: string): string[] {
  const parent = parentOf(path);
  return parent === null ? [path] : [...canonicalStack(parent), path];
}

/** Hur webbläsarens historik ändras: först så många steg bakåt, sedan nya steg. */
export interface Plan {
  readonly back: number;
  readonly push: readonly string[];
  /** Första steget byts ut. Behövs bara om historiken inte började på Översikt. */
  readonly replace?: string;
}

/** Från historiken som den är till historiken som den ska vara, med så få ändringar som möjligt. */
export function plan(current: readonly string[], next: readonly string[]): Plan {
  let same = 0;
  while (same < current.length && same < next.length && current[same] === next[same]) same += 1;
  if (same > 0) return { back: current.length - same, push: next.slice(same) };
  // Inget gemensamt första steg: appens första steg går inte att lämna bakåt, så det ersätts.
  const [first = "/", ...rest] = next;
  return { back: current.length - 1, push: rest, replace: first };
}

/** Fliken som en kedja hör till: fliken för steget ovanpå Översikt, även om sista vyn ligger under en annan flik. */
export function tabOfStack(stack: readonly string[]): Tab {
  const second = stack[1];
  return second === undefined ? "/" : tabOf(second.split("?")[0] ?? second);
}

/**
 * Stegen när man trycker på en flik i menyn (KK-62-F): fliken öppnas där man senast var i den, och ett
 * tryck på fliken man redan står på går till flikens startsida, som i en app.
 */
export function tabTarget(memory: ReadonlyMap<string, readonly string[]>, current: readonly string[], tab: Tab): string[] {
  const remembered = memory.get(tab);
  if (tabOfStack(current) === tab || remembered === undefined || tabOfStack(remembered) !== tab) return canonicalStack(tab);
  return [...remembered];
}
