# Månatlig kostnads- och kvotkontroll

Kronkoll ska gå att driva helt gratis (KK-1). Den här kontrollen visar i tid om något närmar sig en
gräns eller om en betald tjänst har slagits på. Den motsvarar verifieringen `V-m-cost` i planen.

**När:** första helgen varje månad, och en extra gång efter den första stora importen av transaktioner.
**Tid:** cirka 5 minuter. Allt går att göra i mobilen.
**Mål:** under **10 %** av varje gratiskvot. Över 50 % är en signal att se över synkfrekvens eller kod.

Gränserna nedan är antagande A-3 i planen (november 2026). Om Cloudflare visar andra siffror gäller
Cloudflares, och då ska A-3 uppdateras.

## 1. Cloudflare: Workers och Pages

**Workers & Pages → Overview**, flik *This month*.

| Vad | Gräns (gratis) | Mål |
|---|---|---|
| Anrop per dygn (Workers och Pages Functions räknas ihop) | 100 000 | < 10 000 |
| CPU-tid per anrop | 10 ms | Inga fel om *exceeded CPU* |

Kontrollera också att `kronkoll-api` och `kronkoll` står på planen **Free**. En vanlig användning
(en person, 2 synkar per dygn) ger uppskattningsvis under 2 000 anrop per dygn (`D-origin`).

## 2. Cloudflare: D1

**Storage & Databases → D1 → kronkoll → Metrics.**

| Vad | Gräns (gratis) | Mål |
|---|---|---|
| Lästa rader per dygn | 5 miljoner | < 500 000 |
| Skrivna rader per dygn | 100 000 | < 10 000 |
| Lagring | 5 GB | < 500 MB |

## 3. Cloudflare: Zero Trust (Access)

**Zero Trust → Settings → Account** (eller *Plan*).

- Planen är **Free**.
- Antal använda platser (*seats*) är högst 50. För Kronkoll ska det vara en eller två.

## 4. Cloudflare: fakturering

**Profilikonen → Billing.**

- Inga aktiva prenumerationer eller tillägg (till exempel *Workers Paid*, *Argo* eller *R2*).
- Inga fakturor med belopp.

Om ett betalkort är registrerat (Zero Trust kan kräva det även för gratisplanen) ska det bara vara
för Zero Trust. Notera det i protokollet nedan.

## 5. GitHub

**Repot → Settings → Billing and plans** (eller profilens *Billing and licensing*).

- Actions-minuter: gratis och obegränsade för publika repon. Inga betalda körare.
- Inga betalda tillägg för repot.

## 6. Enable Banking

**Enable Banking → Applications.**

- Produktionsappen är fortfarande *Restricted Production* och utan kostnad (antagande A-1).
- Inga fakturor eller betalningsuppmaningar.

## Protokoll

Skriv en kort kommentar i issue #15 (eller ett eget issue per år) efter varje kontroll, utan
kontonummer eller andra bankuppgifter. Påhittat exempel:

```
Kostnadskontroll 2026-12-05
- Workers/Pages: 1 240 anrop/dygn (1,2 %), inga CPU-fel
- D1: 3 100 lästa rader/dygn, 210 skrivna, 4 MB
- Zero Trust: Free, 1 seat
- Billing: inga prenumerationer, inga fakturor
- GitHub: inga betalda tillägg
- Enable Banking: Restricted Production, inga kostnader
Åtgärd: ingen
```

Om något ligger över målet: skriv vad som drar mest och skapa ett issue. Kvoten återställs varje
dygn, och free tier stänger av tjänsten i stället för att fakturera (hot T-D1), så det finns ingen
risk för en oväntad räkning. Däremot kan appen sluta svara resten av dygnet.
