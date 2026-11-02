// Det appen gör med webbläsarens adress och lagring utöver routern. Samlat här så att testerna kan
// ersätta det.

/** Tar bort alla IndexedDB-databaser som webbläsaren kan lista. */
async function deleteDatabases(): Promise<void> {
  const databases = await indexedDB.databases();
  await Promise.all(
    databases.flatMap(({ name }) =>
      name === undefined
        ? []
        : [
            new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(name);
              // Blockerad eller misslyckad: gå vidare ändå, utloggningen får inte fastna.
              request.onsuccess = request.onerror = request.onblocked = () => {
                resolve();
              };
            }),
          ],
    ),
  );
}

/** Kör ett steg i rensningen och fortsätter även om det misslyckas eller saknas i webbläsaren. */
async function tryStep(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Saknas eller nekas: resten av rensningen och utloggningen ska ändå ske.
  }
}

export const browser = {
  /** Lämnar appen för en annan sida, till exempel bankens inloggning. */
  assign(url: string): void {
    window.location.assign(url);
  },

  /**
   * Rensar det appen kan ha sparat på enheten (KK-35): Cache Storage, IndexedDB och webbläsarens
   * lagring. Push-prenumerationer finns inte än och rensas när de byggs (#42).
   */
  async clearDevice(): Promise<void> {
    await tryStep(async () => {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    });
    await tryStep(deleteDatabases);
    await tryStep(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      return Promise.resolve();
    });
  },
};
