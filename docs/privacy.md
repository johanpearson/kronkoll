# Integritetspolicy för Kronkoll

Senast ändrad: 2026-11-01. Ändringar syns i repots historik.

Kronkoll är en privat budgetapp för ett enskilt hushåll. Den är inte en kommersiell tjänst och används bara av
hushållets egna medlemmar, som loggar in via Cloudflare Access.

## Vem ansvarar

Ägaren av repot [github.com/johanpearson/kronkoll](https://github.com/johanpearson/kronkoll) driver appen som
privatperson och ansvarar för uppgifterna. Kontakta ägaren via [GitHub](https://github.com/johanpearson) eller
den e-postadress för dataskydd som Kronkoll har registrerat hos Enable Banking.

## Vilka uppgifter som behandlas

Kronkoll har **bara läsbehörighet** mot banken och kan inte göra betalningar eller ändra något hos banken.

| Uppgift | Varifrån | Varför |
|---|---|---|
| Konton: namn, typ och kontonummer **maskerat till de sista 4 siffrorna** | Banken via Enable Banking | Visa vilka konton som är kopplade |
| Saldon | Banken via Enable Banking | Visa saldo och trender |
| Transaktioner: datum, belopp, motpart och beskrivning | Banken via Enable Banking | Kategorisera, budgetera och visa insikter |
| Bankkopplingens session-id och giltighetstid | Enable Banking | Hämta nya transaktioner tills samtycket går ut. Session-id lagras **krypterat**. |
| Kategorier, regler, budgetar, sparmål | Det du själv anger | Appens funktioner |
| Inkomstparametrar, till exempel SGI, skattesats och planerad föräldraledighet | Det du själv anger | Uppskatta inkomst under ledighet |
| E-postadress för inloggning | Cloudflare Access | Släppa in rätt personer |
| Push-prenumeration (om du slår på notiser) | Din webbläsare | Skicka påminnelser och varningar |

Kronkoll sparar **aldrig** bankens råa API-svar, bara fälten ovan. Inloggningen till banken (BankID) sker hos banken.
Kronkoll ser aldrig dina inloggningsuppgifter.

Driftloggar innehåller bara tekniska fält som id, antal, status och tidsåtgång, aldrig belopp, motparter,
beskrivningar eller kontonummer.

## Var uppgifterna finns och vem som får del av dem

Uppgifterna delas inte med någon och säljs aldrig. Två leverantörer behandlar dem för att appen ska fungera:

- **Enable Banking** förmedlar läsåtkomsten till banken.
- **Cloudflare** kör appen (Pages och Workers), lagrar databasen (D1) och sköter inloggningen (Access).

Repot är publikt men innehåller aldrig bankuppgifter, bara påhittad testdata.

## Hur länge uppgifterna sparas

- **Transaktioner, konton och saldon** sparas tills du raderar dem.
- **Bankens samtycke** gäller som längst den tid banken tillåter, ofta cirka 180 dagar. Därefter måste du koppla om
  för att nya transaktioner ska hämtas.
- **Driftloggar** gallras efter 90 dagar.
- **Säkerhetskopior**: Cloudflares återställningspunkter för databasen sparas i upp till 7 dagar. Raderad data kan
  alltså finnas kvar där i upp till 7 dagar innan den försvinner helt.

## Radera och återkalla

Under **Inställningar → Bankkopplingar** kan du radera en koppling. Då:

1. återkallas samtycket hos Enable Banking och session-id raderas, och
2. om du väljer det raderas även alla konton, transaktioner, uppdelningar och saldon för kopplingen.

Du får en kvittens som visar vad som raderats. Du kan också när som helst återkalla samtycket direkt hos din bank.

**Logga ut** rensar cachad data och push-prenumerationen på enheten.

## Säkerhet

- Hela appen ligger bakom Cloudflare Access. Bara inbjudna e-postadresser kommer in, och sessionen är kort.
- All trafik går över HTTPS.
- Nycklar och hemligheter finns bara som skyddade inställningar hos Cloudflare och GitHub, aldrig i koden.

## Dina rättigheter

Du kan när som helst se och radera dina uppgifter i appen, eller kontakta ägaren för att få ut dem. Du har också rätt att
klaga hos Integritetsskyddsmyndigheten (IMY).

---

**Summary in English:** Kronkoll is a private, non-commercial budgeting app for a single household. It has read-only
access to bank accounts via Enable Banking and can never make payments. It stores accounts (number masked to the
last 4 digits), balances and transactions, never raw bank responses, in Cloudflare D1. Data is not shared with anyone
except the processors Enable Banking and Cloudflare. Data is kept until the user deletes it. Deleting a connection
revokes the consent, and database restore points expire within 7 days.
