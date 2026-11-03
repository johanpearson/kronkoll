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

## Öppna trådar

- Första riktiga förnyelsen av samtycket (#151): ett konto **utan IBAN** som får nytt uid av banken blir ett
  nytt konto. Matcha på namn och typ inom kopplingen om det händer.
- "Bara okategoriserade" i Transaktioner visar även okategoriserade insättningar, medan budgetens belopp bara
  räknar utbetalningar (#153).
- Kvar i M1: #35 (E2E och mutationstest i CI), #29 (CSV-import, kanske stryks) och #24 (avsluta spiken).
