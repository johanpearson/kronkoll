---
name: nasta-issue
description: Plocka upp nästa arbetspaket i den aktuella etappen (i dag M5, issue #241) och gör nästa PR i det. Använd när ägaren säger "nästa issue", "nästa", "fortsätt", "kör nästa" eller "/nasta-issue", eventuellt med ett issuenummer ("/nasta-issue 252") för att välja ett bestämt issue.
---

# Nästa issue

Ägaren ger sessionen ett kort kommando och vill att du själv hittar nästa sak att göra och gör den
enligt repots regler. **Att ägaren anropar den här skillen är beställningen av nästa PR.** Du får
alltså skapa en PR i slutet (AGENTS.md: "Skapa aldrig en PR som ägaren inte bett om").

Följ stegen i ordning. Hoppa inte över steg 1–3, även om du tror att du vet vad som är nästa.

## 1. Läs reglerna

Läs `AGENTS.md` och `docs/agent-notes.md` i sin helhet. De gäller före allt här.

## 2. Ta reda på läget

Etappen är issue **#241** (M5 – Omdesign av appen) i `johanpearson/kronkoll`. Byts etapp, ändra
numret här i samma PR som skapar den nya etappen.

1. Läs #241. Ordningen och checklistan står i beskrivningen.
2. **Bocka av det som är klart:** för varje rad `- [ ] #n` där issue #n är stängt, ändra till
   `- [x] #n` i #241. Rör inget annat i beskrivningen.
3. **Öppna PR:er:** lista öppna PR:er i repot. Finns det en öppen PR som hör till etappen
   (länkar `Closes #n` eller `Part of #n` för ett issue i listan):
   - Har den fel i CI eller obesvarade granskningskommentarer: åtgärda dem på PR:ens gren och stanna där.
   - Annars: säg till ägaren att den väntar på merge, med länk, och **stanna**. Börja inte på något nytt
     (agent-notes: "Vänta på 'den är mergad' innan nästa PR i samma kedja påbörjas"). Undantag: ägaren
     har uttryckligen sagt att du ska jobba parallellt, och det nya issuet beror inte på den öppna PR:en.

## 3. Välj issue

Har ägaren angett ett nummer, använd det och gå till steg 4.

Annars:
1. **Påbörjat issue först:** ett öppet issue i listan som redan har en mergad PR med `Part of #n` är
   påbörjat. Fortsätt med nästa PR i det enligt issuets *Föreslagna PR:er*.
2. **Annars:** ta det första omarkerade issuet i #241:s ordning som
   - är öppet,
   - inte är en manuell uppgift för ägaren (t.ex. #180, som bara är inställningar i Cloudflare; påminn
     ägaren om det i stället),
   - har alla sina beroenden klara. Beroenden står som "Beror på …" i issuet. Ett beroende är klart när
     det issuet är stängt, eller när den del som behövs (t.ex. "PR 1–2") är mergad.

   Inom ett spår gäller ordningen i listan. Spår 1 och 2 i #241 får gå parallellt, så välj det första
   lediga i listan som helhet.
3. Finns inget som går att göra: säg vad som blockerar (öppen PR, beroende eller fråga till ägaren) och stanna.

Säg i en mening vilket issue och vilken PR i kedjan du tar, och varför. Börja sedan direkt. Vänta inte på svar.

**Namnge sessionen** direkt efter valet, så att ägaren ser i sessionslistan vad den gör. I molnsessioner:
hämta sessionens id med `get_session` utan id (claude-code-remote) och sätt titeln med `set_session_title`.
Format: `#<issue> <kort svensk titel> – PR <k>/<n>`, t.ex. `#252 Preliminära som i en bankapp – PR 1/3`.
Om `n` inte är känt skriver du bara `PR <k>`.
- Fortsätter du med en öppen PR (steg 2.3): `#<issue> Åtgärda PR #<pr>`.
- Stannar du utan att göra något: `M5: väntar på merge av #<pr>`, eller `M5: blockerad – <orsak>`.

Saknas verktygen, t.ex. när skillen körs lokalt, hoppar du över det här steget.

## 4. Förbered

1. Läs hela issuet och dess kommentarer. Kommentarer från ägaren går före beskrivningen.
2. Kontrollera att kravid som issuet nämner finns i `plans/kronkoll/requirements.json`. Saknas de och
   issue #242 (krav och plan) inte är klart: gör #242 först, eller lägg in just de kraven i samma PR om
   det ryms inom storleksgränsen. Gör så som AGENTS.md säger: krav först, sedan plan, sedan
   `reqplan` (`anthropic-skills:reqplan`, med `check`, `build` och `build --mode prototype`).
3. Gren: använd den gren som sessionen har fått sig tilldelad om det finns en. Annars `m5/<issue>-<kort-namn>`
   från senaste `origin/main`. Har grenens förra PR mergats: börja om grenen från `origin/main`.
4. Läs koden som issuet pekar på innan du ändrar något.

## 5. Gör en PR, inte hela issuet

- **En PR i taget**, ≤ 400 ändrade rader (genererade filer räknas inte). Följ issuets *Föreslagna PR:er*.
  Saknas en sådan lista: dela själv i domän → API → UI och skriv uppdelningen i PR:en.
- TDD för all domänlogik (KK-15). Skriv testet först.
- Rader märkta **Assumption** i issuet bygger du som de står, och du för dem vidare till PR:ens
  *Open questions and decisions*, så att ägaren kan bekräfta dem.
- Är något oklart, och avgör det beteendet för användaren: gissa inte. Fråga ägaren kort och stanna,
  eller bygg det enklaste alternativet och skriv frågan under *Open questions*. Välj det första bara när
  ett fel val skulle ge mycket omarbete.
- Säkerhetsreglerna i AGENTS.md gäller alltid: inga hemligheter, ingen riktig bankdata och banktext
  renderas som text.

## 6. Kontrollera innan push

Kör allt som `docs/agent-notes.md` listar under *Kontroller innan push*: lint, typecheck, rotens tsc och
architecture, och `test:coverage` **ett paket i taget** för paketen du rört. Rör du `apps/api`: kör även
`test:integration`. Rör du `apps/web`: kör E2E, och i molnsessioner gäller tipset om Chromium i agent-notes.
Inaktivera aldrig tester eller grindar.

## 7. Skapa PR:en

- Titel och beskrivning enligt AGENTS.md och `.github/pull_request_template.md`: engelska, alla fyra rubrikerna.
- Under *What and why*: `Closes #n` om PR:en gör issuet klart, annars `Part of #n`, och `Part of #241`.
  Skriv vilken PR i kedjan det är, t.ex. "PR 2 of 3".
- Följ PR:en om sessionen kan det (prenumerera på PR-aktivitet) och åtgärda CI-fel. Merga aldrig själv.

## 8. Avsluta

- Har du lärt dig något som nästa agent behöver veta: lägg till det i `docs/agent-notes.md` i samma PR.
- Blir ett krav helt uppfyllt när PR:en mergas: skriv det i PR:en, så uppdateras #43 efter merge
  (bocka av vid nästa körning, steg 2).
- Avsluta med tre rader till ägaren: vad PR:en gör (med länk), vad som återstår av issuet, och vad
  som blir nästa sak efter merge.
