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

## Frågor som flyttas vidare

Följande går bara att besvara när koden hämtar transaktioner från produktions-API:t. Det ska
göras från Workern, så att produktionsnyckeln aldrig lämnar Cloudflare (D-secrets).

| Fråga | Besvaras i |
|---|---|
| Levereras preliminära (PDNG) transaktioner för konto och kort? | #24 (Enable Banking-adaptern) |
| Hur långt bakåt går historiken vid första kopplingen? | #24 |
| CPU-tid i Workern för att importera en sida transaktioner (risk R-3, gränsen 10 ms) | #24 |
| Hur syns Försäkringskassan och lön som motpart (antagande A-6)? | #37 (inkomstklassning) |

## Så körs spiken igen

**Actions → spike-enable-banking → Run workflow** i GitHub-appen eller på webben. Den använder
sandbox-nyckeln i miljön `sandbox`, signerar en kortlivad JWT och skriver en sammanfattning i
körningens *Summary*. Den hämtar aldrig konton eller transaktioner.
