// En liten router för en handfull sidor: adressen är sanningen, länkar byter sida utan omladdning
// och bakåt-knappen fungerar. Ett routerbibliotek kan ersätta den när appen växer (#30).
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function Link({ to, children, current = false }: { to: string; children: ReactNode; current?: boolean }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Ny flik, nytt fönster och liknande sköts av webbläsaren som vanligt.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} aria-current={current ? "page" : undefined}>
      {children}
    </a>
  );
}
