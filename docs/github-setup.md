# GitHub-inställningar för Kronkoll

Repot är **publikt** (beslut D-repo). Inställningarna nedan går inte att committa, utan görs i GitHub-UI:t
(Settings). De hör till M0 och är förutsättningen för KK-12, KK-16 och KK-31.

## 1. Default branch = `main`

Settings → General → Default branch → välj **`main`**.

## 2. Branch protection för `main` (ruleset)

Settings → Rules → Rulesets → **New ruleset → Import a ruleset** → välj
[`.github/rulesets/main.json`](../.github/rulesets/main.json) → **Create**.

Rulesetet `main-skydd` gäller default branch och `main`:

| Regel | Varför |
|---|---|
| Ändringar bara via pull request (squash) | Allt går genom grindarna (KK-16-B) |
| 0 godkännanden krävs, men alla konversationer måste vara lösta | Du är ensam i repot och kan inte godkänna din egen PR. Höj till 1 när en partner eller medutvecklare tillkommer. |
| Statuskontrollen **`ci-ok`** måste vara grön, och grenen uppdaterad mot `main` | `ci-ok` samlar alla grindar i `ci.yml`. Nya grindar läggs till i `needs:` utan att rulesetet ändras. |
| Linjär historik, ingen force push, ingen radering | Spårbar historik |
| Inga bypass-aktörer | Inte ens admin kan pusha direkt. Lägg vid behov till *Repository admin* som bypass för nödfall. |

> Statuskontrollen `ci-ok` kan bara väljas efter att `ci.yml` har körts minst en gång (det sker vid första PR:en).
> Importen fungerar ändå, eftersom kontexten redan är angiven.

Valfritt: regeln *Require signed commits* om du signerar dina commits.

## 3. Säkerhet (Settings → Advanced Security / Code security)

- **Secret scanning** och **Push protection**: på (gratis för publika repon) – KK-12-B
- **Dependabot alerts** och **Dependabot security updates**: på
- **Private vulnerability reporting**: på

## 4. Actions (Settings → Actions → General)

- *Workflow permissions*: **Read repository contents** (minsta behörighet, KK-31)
- *Allow GitHub Actions to create and approve pull requests*: **av**
- *Fork pull request workflows from outside collaborators*: **Require approval for all external contributors**.
  Repot är publikt, så främmande PR:er får inte köra workflows utan att du godkänt dem.
- *Allow actions*: valfritt att begränsa till actions från GitHub, verifierade skapare och de som pinnats i repot

## 5. Miljöer för deploy (läggs till i M0 med `deploy.yml`)

Settings → Environments → **production**:
- *Deployment branches*: endast `main`
- Secrets: `CLOUDFLARE_API_TOKEN` (avgränsad till Workers/Pages/D1 för ett konto) och `CLOUDFLARE_ACCOUNT_ID`.
  De ligger **bara** i miljön, aldrig som repo-secrets, så att PR-jobb inte kan nå dem (KK-31, T-I4).

## 6. Övrigt (Settings → General)

- *Automatically delete head branches*: på
- *Allow merge commits* och *Allow rebase merging*: av (bara squash)

## Verifiera (V-m-ruleset)

1. `git push origin main` direkt ska nekas.
2. En PR med röd `ci-ok` kan inte mergas.
3. En testgren med en påhittad PEM-nyckel stoppas av push protection eller av `secret-scan`.
