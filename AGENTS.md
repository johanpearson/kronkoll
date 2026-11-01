# AGENTS.md – arbetsregler för Kronkoll

Gäller alla som bidrar till repot, människor som AI-agenter. Kort och bindande. Detaljer finns i planen.

## Projektet

- Kronkoll är en personlig budgetapp på Cloudflare free tier (Pages + Workers + D1 + Access) med bankdata via Enable Banking.
- **Källan till sanning** är kraven i [`plans/kronkoll/requirements.json`](plans/kronkoll/requirements.json) (KK-1…KK-35) och planen i
  [`plans/kronkoll/plan.json`](plans/kronkoll/plan.json). Öppna `plan.html` för en klickbar version.
  Ändras ett krav ändras det där först. Bygg sedan om planen med reqplan.
- Arkitekturen är ports & adapters: `packages/domain` är ren TypeScript utan beroenden (KK-14). Cloudflare, Enable Banking,
  D1 och Web Push finns bara i adaptrar och appar.
- TDD för all domänlogik (KK-15). Grindar i CI: se `.github/workflows/ci.yml` och jobbet `ci-ok`.
- UI-texter är på svenska och belopp anges i SEK. Belopp lagras som heltal öre (D-money).

## Säkerhet – aldrig förhandlingsbart

- Inga hemligheter, nycklar, tokens eller riktig bankdata i repot, i loggar, i tester eller i PR-texter (KK-12, KK-13).
  Använd bara syntetiska fixtures och Enable Bankings sandbox.
- Endast läsbehörighet mot banken. Ingen kod för betalningar (KK-5-A).
- Banktexter (motpart, beskrivning) är opålitlig indata och renderas alltid som text (KK-30).

## Pull requests

Kod granskas sällan rad för rad. Därför ska **PR-titeln och beskrivningen gå att förstå utan att läsa koden**.
De skrivs för en människa som kommer tillbaka efter några veckor.

### Små PR:er

- Sikta på **≤ 400 ändrade rader** per PR. Genererade filer (`plans/**/*.html`, lockfiler, snapshots) räknas inte.
- Över 400 rader ger CI en varning. **Över 800 rader** stoppar CI, om inte PR:en har etiketten `large-pr` och
  beskrivningen förklarar varför den inte gick att dela upp.
- En PR gör **en sak**. Dela hellre upp i en kedja: först port + domänlogik + tester, sedan adapter, sist UI.
  Refaktorering och beteendeändring hamnar i separata PR:er.
- Varje PR ska lämna `main` grön och deploybar. Ofärdiga funktioner döljs eller lämnas oanslutna.

### Titel

- Engelska, imperativ form, ≤ 72 tecken, och den beskriver **effekten för användaren eller systemet**, inte filerna.
  Bra: `Deduplicate pending transactions when the bank changes ids`.
  Dåligt: `Update reconcile.ts`, `WIP`, `Fix stuff`.
- Lägg gärna till kravid sist: `… (KK-9)`.

### Beskrivning

Beskrivningen skrivs på engelska. Använd mallen i [`.github/pull_request_template.md`](.github/pull_request_template.md). Alla fyra rubrikerna är obligatoriska
och kontrolleras i CI (`pr-description`):

1. **What and why**: vad ändras och vilket problem det löser, i 2–5 meningar i klartext. Ange vilka krav eller
   acceptanskriterier (KK-…) som berörs.
2. **How to test**: konkreta steg som en människa kan följa (kommandon, var man klickar, vad som ska synas).
3. **How we know it works**: vilka automatiska tester som täcker ändringen, nya eller ändrade, och vad de visar,
   samt resultat från CI, mutationstest och E2E. Säg ärligt vad som **inte** är testat.
4. **Open questions and decisions**: beslut som tagits i PR:en (med motivering), antaganden och frågor som ägaren
   behöver svara på. Skriv "None" om det inte finns några.

### Issues och krav

- Roadmappen finns som issues: etapperna #3 (M0) till #7 (M4) har arbetspaketen som underissues. Kravspårningen finns i #43.
- Varje PR länkar sitt issue med `Closes #n` (eller `Part of #n`) under *What and why* och nämner vilka krav (KK-…) den berör.
- När ett krav blir helt uppfyllt uppdateras statuskolumnen i #43.

Undvik upprepade fillistor och kodutdrag som går att se i diffen. Förklara i stället *varför*.

## För AI-agenter

- Följ planen. Om något i planen inte håller, skriv det under *Open questions and decisions* i stället för att tyst avvika.
- Skapa aldrig en PR som ägaren inte bett om. Merga aldrig själv.
- Kör repots egna kontroller lokalt innan push. Inaktivera aldrig tester eller grindar för att få CI grön.
- Markera antaganden som **Assumption:** i PR-texten.
