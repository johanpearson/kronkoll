// En liten router med historik som i en app (KK-62). Adressen är sanningen och länkar byter sida utan
// omladdning. Webbläsarens historik hålls kort enligt reglerna i nav/stack.ts: Översikt är första steget,
// en flik ligger ovanpå den och undervyer ovanpå vyn de öppnades från. Varje steg sparar hela kedjan i
// history.state, så att bakåt och omladdning vet var de är.
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { canonicalStack, plan } from "./nav/stack.ts";

const listeners = new Set<() => void>();
/** Sant medan routern själv går bakåt, så att mellanstegen inte ritas. */
let busy = false;

const notify = () => {
  for (const listener of listeners) listener();
};

window.addEventListener("popstate", () => {
  if (!busy) notify();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const here = () => window.location.pathname + window.location.search;
const pathOf = (url: string) => url.split("?")[0] ?? url;

/** Adressens steg, med frågan kvar på sista steget. */
const stepsTo = (url: string) => [...canonicalStack(pathOf(url)).slice(0, -1), url];

function currentStack(): string[] {
  const saved = (window.history.state as { stack?: unknown } | null)?.stack;
  if (Array.isArray(saved) && saved.length > 0 && saved.every((s) => typeof s === "string")) return saved;
  return stepsTo(here());
}

function push(stack: readonly string[]) {
  window.history.pushState({ stack }, "", stack.at(-1));
}

/** Körs en gång när appen startar: en djuplänk får samma steg bakåt som om man gått dit (KK-62-G). */
export function startHistory(): void {
  const saved = (window.history.state as { stack?: unknown } | null)?.stack;
  if (Array.isArray(saved) && saved.at(-1) === here()) return;
  const steps = stepsTo(here());
  window.history.replaceState({ stack: steps.slice(0, 1) }, "", steps[0]);
  for (let i = 2; i <= steps.length; i += 1) push(steps.slice(0, i));
}

/** Går n steg bakåt och väntar tills webbläsaren är klar. */
function back(n: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("popstate", done);
      clearTimeout(timer);
      resolve();
    };
    // Om webbläsaren av någon anledning inte svarar fortsätter routern ändå.
    const timer = setTimeout(done, 1000);
    window.addEventListener("popstate", done);
    window.history.go(-n);
  });
}

async function apply(current: readonly string[], next: readonly string[]) {
  const steps = plan(current, next);
  if (steps.back > 0) {
    busy = true;
    await back(steps.back);
    busy = false;
  }
  let stack = next.slice(0, next.length - steps.push.length);
  if (steps.replace !== undefined) window.history.replaceState({ stack }, "", steps.replace);
  for (const url of steps.push) {
    stack = [...stack, url];
    push(stack);
  }
  notify();
}

/**
 * Byter vy. En flik i menyn ("tab") ersätter fliken (KK-62-A). Annat läggs ovanpå vyn det öppnades
 * från (KK-62-B), utom en vy som redan ligger bakom, dit routern i stället går tillbaka.
 */
export function navigate(to: string, mode: "push" | "tab" = "push"): void {
  const current = currentStack();
  let next: string[];
  if (mode === "tab" || to === "/") {
    next = stepsTo(to);
  } else {
    const index = current.indexOf(to);
    next = index >= 0 ? current.slice(0, index + 1) : [...current, to];
  }
  void apply(current, next);
}

/** Byter adressen för vyn man står på, t.ex. när ett filter tas bort, utan att ändra stegen bakåt. */
export function replaceUrl(url: string): void {
  window.history.replaceState({ stack: [...currentStack().slice(0, -1), url] }, "", url);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function Link(props: { to: string; children: ReactNode; current?: boolean; className?: string; tab?: boolean }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Ny flik, nytt fönster och liknande sköts av webbläsaren som vanligt.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(props.to, props.tab ? "tab" : "push");
  };
  return (
    <a href={props.to} className={props.className} onClick={onClick} aria-current={props.current ? "page" : undefined}>
      {props.children}
    </a>
  );
}
