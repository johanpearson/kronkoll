# Spike-protokoll: Skandia via Enable Banking

Resultat från spiken i M0 (#8), 2026-11-01. Protokollet innehåller **ingen bankdata**: inga
kontonummer, belopp, saldon eller transaktioner (KK-12, KK-13).

## Sammanfattning

MVP:n går att bygga som planerat. Skandia finns hos Enable Banking, Visa-kortet kommer som ett
eget konto och Restricted Production är gratis för privat bruk. CSV-import behövs bara för Amex.

## Svar

| Fråga | Svar | Hur det kontrollerades |
|---|---|---|
| Fungerar JWT-signeringen (#50) mot det riktiga API:t? | **Ja.** `GET /application` godkände token. | Workflowen `spike-enable-banking` mot sandboxen |
| Finns Skandia i `GET /aspsps?country=SE`? | **Ja**, ASPSP-namnet är `Skandia`, för kundtyperna `personal` och `business`, inte beta. | Samma workflow (64 svenska banker i listan) |
| Längsta samtycke (`maximum_consent_validity`) | **180 dagar**, för alla 64 svenska banker | Samma workflow |
| Fungerar Skandia i produktion? | **Ja.** Alla konton syns efter BankID, och appen står som *Active*. | Johan länkade produktionsappen i Enable Bankings kontrollpanel |
| Kommer Visa-kortet som eget konto? | **Ja.** CSV-import behövs alltså bara för Amex (KK-6-B). | Samma länkning |
| Villkor för Restricted Production | **Tillåtet för privatpersoners eget bruk** med egna länkade konton. Ingen kostnad nämns. Kommersiellt bruk och åtkomst för tredje part är förbjudet. Antalet länkade konton kan begränsas, men ingen siffra anges. Bara konton som tillhör den som länkade dem får läsas, vilket passar eftersom Kronkoll har en användare (KK-28). | Villkoren under *Restriction of Use* |

Detta verifierar antagande A-1 och Skandia-delen av A-2, och besvarar de öppna frågorna `Q-skandia`
och `Q-eb-terms` i planen (#62).

## Svar från produktion (#24)

Tre frågor gick bara att besvara när Workern hämtade riktiga transaktioner. Kopplingen gjordes
2026-11-02 och svaren togs fram 2026-11-04. Johan körde frågor mot produktionsdatabasen och
`wrangler tail` i sin egen miljö. Frågorna gav bara status, antal, datum och CPU-tid, aldrig banktext.

| Fråga | Svar | Hur det kontrollerades |
|---|---|---|
| Levereras preliminära (PDNG) transaktioner för konto och kort? | **Ja.** Ett av de två konton som korten är kopplade till hade tre preliminära transaktioner. Det andra hade inga just då, vilket inte säger att de saknas. Skandia skickar `booking_date` även på preliminära, så den kan inte användas för att skilja dem från bokförda. | `transactions` grupperat per konto och status |
| Hur långt bakåt går historiken vid första kopplingen? | **Minst 90 dagar, men det är så långt vi ber om.** Första synken frågar efter 90 dagar (`FIRST_SYNC_DAYS`), och de aktiva kontona har transaktioner ända från första dagen i fönstret. Hur mycket mer Skandia ger är inte prövat. Enable Banking kan hämta längsta möjliga period med `strategy=longest`, vilket KK-5-C kräver. | Äldsta `transaction_date` per konto jämfört med första körningen i `sync_runs` |
| CPU-tid i Workern (risk R-3, gränsen 10 ms) | **En hel synk tar runt 100 ms CPU**, alltså långt över 10 ms. En manuell synk av fyra konton tog 108 ms CPU och 11 s väggtid och slutade ändå med `outcome: ok`. Vanliga API-anrop tar 0–7 ms. Första synken (500 transaktioner) gick klart, och ingen körning i `sync_runs` har blivit hängande. CPU-tid per sida går inte att mäta separat, eftersom hela synken körs i ett anrop. Risken R-3 är alltså inte borta: Cloudflare har inte stoppat anropen hittills, men gränsen är överskriden. | `wrangler tail kronkoll-api --format json` under "Synka nu", och `sync_runs` |

## Frågor som flyttas vidare

| Fråga | Besvaras i |
|---|---|
| Hur syns Försäkringskassan och lön som motpart (antagande A-6)? | #37 (inkomstklassning) |

## Så körs spiken igen

**Actions → spike-enable-banking → Run workflow** i GitHub-appen eller på webben. Den använder
sandbox-nyckeln i miljön `sandbox`, signerar en kortlivad JWT och skriver en sammanfattning i
körningens *Summary*. Den hämtar aldrig konton eller transaktioner.
