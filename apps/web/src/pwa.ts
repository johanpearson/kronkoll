// Registrerar service workern så att appen kan installeras och startar utan nät (KK-25-A). Utan stöd
// i webbläsaren, eller om registreringen misslyckas, fungerar appen ändå som en vanlig webbsida.
export function registerServiceWorker(nav: Navigator = navigator): void {
  if (!("serviceWorker" in nav)) return;
  nav.serviceWorker.register("/sw.js").catch(() => {
    // Appen fungerar utan, bara utan installation och offline-skal.
  });
}
