# Praktiska anteckningar för agenter

Reglerna står i [`AGENTS.md`](../AGENTS.md). Här står det som har lärts under arbetet och som annars är
lätt att trampa fel på. Håll den kort och uppdatera den när något nytt lärs.

## Arbetssätt med ägaren

- Ägaren skriver på svenska och svarar på svenska. PR-titlar och PR-texter är på engelska (AGENTS.md).
- En liten PR i taget. Vänta på "den är mergad" innan nästa PR i samma kedja påbörjas. Ägaren mergar själv.
- Titeln får vara högst 72 tecken **inklusive** kravid, t.ex. `… (KK-20)`. Räkna efter att kravid är tillagt.
- Följ upp kravstatus i issue #43 när ett krav blir helt uppfyllt.
- Nya önskemål som saknas i kraven läggs först in i `plans/kronkoll/requirements.json` (nästa lediga KK-nummer),
  sedan i `plan.json`, och planen byggs om innan koden skrivs.

## Kontroller innan push

```bash
pnpm lint
pnpm typecheck
pnpm architecture
pnpm --filter @kronkoll/<paket> test:coverage
```

- Kör `test:coverage` **ett paket i taget** (`domain`, `adapter-d1`, `adapter-enablebanking`, `api`, `web`).
  När alla körs parallellt på ägarens dator får några web- och adapter-d1-tester ibland timeout. Det är
  belastning, inte fel i koden.
- Täckningskravet är 90 % per paket, även grenar. `adapter-d1` ligger nära gränsen för grenar.
- Planen kontrolleras och byggs med reqplan: `check`, `build` och `build --mode prototype` på
  `plans/kronkoll/plan.json`. HTML-filerna räknas inte i PR-storleken.

## Mutationstest (Stryker)

- `pnpm --filter @kronkoll/domain test:mutation` kör allt (cirka 4 minuter). Lägg till `--incremental` för att
  bara köra om det som ändrats sedan förra körningen (`reports/stryker-incremental.json`).
- Stryker 10 kräver Node `^22.18` eller `>=24.11`, och `.npmrc` har `engine-strict`. Äldre Node 24 lokalt
  stoppar `pnpm install`. Använd Node enligt `.nvmrc`.
- Inkrementellt läge testar inte om **statiska mutanter** (data på modulnivå, t.ex. kategorimallen) när bara
  testerna ändras. Kör med `--incremental --force` för det riktiga värdet. Det gör den nattliga körningen.
- Överlevande mutanter dödas med tester, inte med `// Stryker disable`. Felmeddelanden testas med texten,
  t.ex. `toThrow("Ogiltigt belopp")`, inte bara `toThrow(RangeError)`.

## Integrationstester (Workers-miljön)

- `pnpm --filter @kronkoll/api test:integration` kör den riktiga API-workern i workerd med en migrerad lokal D1
  (`apps/api/integration/`, `vitest.integration.config.ts`). Är en egen grind i CI (`integration`).
- `@cloudflare/vitest-pool-workers` stöder inte Vitest 5. Paketet har bytt namn till `@cloudflare/vitest-plugin`
  med samma API. Använd det.
- `cloudflare:test` och `cloudflare:workers` finns bara i runtime. De är tillagda som `builtInModules` i
  `.dependency-cruiser.json`, annars faller `pnpm architecture`.
- Workern körs i samma isolat som testerna, så `vi.spyOn(globalThis, "fetch")` stubbar även workerns anrop.

## E2E (Playwright)

- `pnpm --filter @kronkoll/web test:e2e` bygger webben, startar `wrangler pages dev` (samma `_headers` och CSP
  som i drift) och kör `apps/web/e2e/` i Chromium med Pixel 7-viewport (R-7). Är en egen grind i CI (`e2e`).
- Access och banken går inte att nå lokalt, så `/api/*` besvaras av `e2e/fake-api.ts` med påhittad data och
  ett litet tillstånd per test. Nya vyer behöver nya svar där, i samma form som det riktiga API:t.
- Första gången: `pnpm --filter @kronkoll/web exec playwright install chromium`. `pnpm` måste finnas i PATH,
  eftersom webbservern startas med `pnpm preview` (`corepack enable` räcker).
- Transaktionslistan är grupperad per dag med nästlade `<li>`. Filtrera bort dagens rubrik för att få en rad.
- `e2e/a11y.spec.ts` kör axe (WCAG 2.1 A och AA) på huvudvyerna i ljust och mörkt läge via
  `emulateMedia({ colorScheme })`. En ny vy läggs till i `VIEWS`, och fake-API:t måste svara på alla dess
  anrop: testet kräver att ingen `role="alert"` syns, så att axe granskar riktigt innehåll.
- `e2e/lighthouse.spec.ts` kör Lighthouse (mobil, simulerad strypning) på `/` och `/transaktioner`. Lighthouse
  öppnar en egen flik via CDP-porten i en `launchPersistentContext`, och fake-API:t läggs på hela kontexten.
  Krav: tillgänglighet och bästa praxis 100, prestanda ≥ 90. Lighthouse 13 saknar PWA-kategori; installbarheten
  (KK-25-A) kontrolleras i `e2e/pwa.spec.ts` med Chromiums `Page.getInstallabilityErrors` via CDP.

## PWA och service worker

- Egen liten service worker utan beroenden (ägarens val 2026-11-04, i stället för vite-plugin-pwa). Logiken
  finns i `apps/web/src/sw/shell.ts` med tester, och `src/sw/sw.ts` byggs av Vite till `/sw.js` utan hash.
  sw.js får inte innehålla `import`, eftersom den registreras som klassiskt skript.
- Service workern rör aldrig `/api/` eller `/cdn-cgi/`, och sparar aldrig en omdirigering (Access-inloggningen).
- Manifestet länkas med `crossorigin="use-credentials"`, annars hämtas det utan Access-cookie och stoppas.
- Ikonerna ritas från `public/icons/icon.svg` med `node scripts/icons.ts` i `apps/web`.

## Cloudflare och D1: gränser som har orsakat riktiga fel

- **CPU-tid:** Workern får runt 10 ms CPU per anrop på gratisnivån. Gör dyra steg (normalisering av
  butiksnamn, regex) **en gång per transaktion**, aldrig en gång per regel och transaktion (se #140).
- **Högst 100 parametrar per D1-fråga.** Använd underfrågor (`IN (SELECT …)`) i stället för listor med id.
- **Drizzle i underfrågor:** `${tabell.id}` inne i en `sql`-underfråga blir okvalificerat (`"id"`) och kan
  jämföra fel tabell. Skriv tabellnamnen ut, t.ex. `accounts.connection_id = bank_connections.id`.
- **Kaskader:** att radera en koppling tar med konton, transaktioner och uppdelningar (`ON DELETE CASCADE`).
  Återhoppet efter BankID får därför **aldrig** radera en koppling som redan har varit aktiv (se #151).

## Skandias data (Enable Banking)

- Skandia skickar **ingen motpart**. Butiken står i meddelandet (`remittance_information`, sparas som
  `description`), t.ex. `LIDL188HOOR, STOCKHOLM` eller `AmazonMktplc*BT4W355R4, www.amazon.se`.
  Regler matchar därför på `ruleKey` (motparten, annars meddelandet normaliserat).
- Normaliseringen tar bort ort efter sista kommatecknet, ordernummer efter `*`, ord med siffror på flera
  ställen (koder) och delar av butiksnummer som sitter ihop med namnet. Se `packages/domain/src/normalize.ts`.
- Alla fyra konton har typen `checking`; två av dem hör till kort. Samtycket går ut 2027-05-01.
- Använd aldrig riktig bankdata i tester, loggar eller PR-texter (KK-13). Testtexter ska vara påhittade men
  i samma format.

## Ägarens miljö

- `wrangler` är inloggad i ägarens WSL, inte i agentens skal. Frågor mot produktionsdatabasen får ägaren köra,
  och de ska bara ge antal, aldrig banktext.
- Förhandsvisning av webben: `pnpm --filter @kronkoll/web build`, sedan `wrangler pages dev dist --port 8788`
  i `apps/web`. API:t finns inte där, så stubba `window.fetch` i sidan för att se en vy med data.
- Hemligheter (`EB_PRIVATE_KEY`, `EB_APP_ID`, `SESSION_ENC_KEY`) ligger i Cloudflare och i ägarens Bitwarden,
  aldrig i repot.

## Redigera filer

- Heredocs och `sed` med backslash eller `'` i SQL har gått sönder flera gånger, bland annat ett regex som
  tappade sina `\d`. Använd redigeringsverktyget för kod med backslash, och läs tillbaka raden efteråt.
- Windows PowerShell 5: `Get-Content`/`Set-Content` utan `-Encoding` förstör å, ä och ö i UTF-8-filer, och
  `-Encoding utf8` lägger till BOM. Använd redigeringsverktyget.

## Öppna trådar

- Första riktiga förnyelsen av samtycket (#151): ett konto **utan IBAN** som får nytt uid av banken blir ett
  nytt konto. Matcha på namn och typ inom kopplingen om det händer.
- "Bara okategoriserade" i Transaktioner visar även okategoriserade insättningar, medan budgetens belopp bara
  räknar utbetalningar (#153).
- Kvar i M1: #29 (CSV-import, kanske stryks) och #24 (avsluta spiken).
- KK-39 Räknas inte bygger på `manual_transfer` från #120 (ägarens beslut 2026-11-04). Regler med
  `action = 'exclude'` är steg 4 i `classifyTransfers`, så de gäller hela historiken och omräkningen
  (`recomputeTransfers`) måste köras när en sådan regel sparas, ändras eller tas bort.
- Migrering 0006 var den första som bygger om en tabell. `drizzle-kit generate` skriver
  `PRAGMA foreign_keys=OFF` (D1 tillåter det inte) och kopierar nya kolumner från den gamla tabellen.
  Läs och rätta genererad SQL innan commit.
