# Kronkoll

[![CI](https://img.shields.io/github/actions/workflow/status/johanpearson/kronkoll/ci.yml?branch=main&label=CI&logo=github)](https://github.com/johanpearson/kronkoll/actions/workflows/ci.yml?query=branch%3Amain)
[![Deploy](https://img.shields.io/github/actions/workflow/status/johanpearson/kronkoll/deploy.yml?branch=main&label=deploy&logo=cloudflare)](https://github.com/johanpearson/kronkoll/actions/workflows/deploy.yml)
[![Mutation (nightly)](https://img.shields.io/github/actions/workflow/status/johanpearson/kronkoll/mutation-nightly.yml?label=mutation%20%28nightly%29)](https://github.com/johanpearson/kronkoll/actions/workflows/mutation-nightly.yml)
[![Bank sandbox (nightly)](https://img.shields.io/github/actions/workflow/status/johanpearson/kronkoll/contract-enable-banking.yml?label=bank%20sandbox%20%28nightly%29)](https://github.com/johanpearson/kronkoll/actions/workflows/contract-enable-banking.yml)

![Coverage gate](https://img.shields.io/badge/coverage%20gate-%E2%89%A590%25-informational)
![Mutation gate](https://img.shields.io/badge/mutation%20gate-%E2%89%A585%25-informational)
![Lighthouse gate](https://img.shields.io/badge/lighthouse%20a11y-100-informational)
![Node](https://img.shields.io/badge/node-22-339933?logo=nodedotjs&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A personal budget app for one household. It reads transactions from the bank, sorts them into
categories and shows where the money went this month. The interface is in Swedish and all amounts are in SEK.

## What it does

- Connects to the bank through [Enable Banking](https://enablebanking.com/) with **read-only** access. There is no code for payments.
- Syncs transactions, removes duplicates and categorises them with rules you teach it.
- Shows a monthly overview and budget per category, and works as an installable app on the phone.

## How it is built

| Part | Where |
|---|---|
| Web app (PWA) | `apps/web` on Cloudflare Pages |
| API | `apps/api` on Cloudflare Workers with D1 |
| Business rules | `packages/domain`, plain TypeScript with no dependencies |
| Bank, database, login | `packages/adapter-*` (ports and adapters) |

Everything runs on the Cloudflare free tier behind Cloudflare Access.

## Quality

Every pull request must pass the `ci-ok` gate before it can be merged, and only a green `main` is deployed.
The gate runs secret scanning, lint, type checks, architecture rules, unit tests with at least 90 % coverage,
mutation tests of the domain (at least 85 %), integration tests in the Workers runtime, and end-to-end tests
on a phone viewport with accessibility and Lighthouse checks.

Each night a full mutation run checks the domain, and a contract test runs against the bank's sandbox.

## Run it locally

Requires Node 22 (see `.nvmrc`) and pnpm via Corepack.

```bash
corepack enable
pnpm install
pnpm lint && pnpm typecheck && pnpm architecture
pnpm --filter @kronkoll/domain test:coverage
```

## More

- Requirements and plan: [`plans/kronkoll`](plans/kronkoll) (open `plan.html` for a clickable version)
- How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md)
- Reporting a security issue: [SECURITY.md](SECURITY.md)
- Privacy and terms (Swedish): [docs/privacy.md](docs/privacy.md), [docs/terms.md](docs/terms.md)

## License

[MIT](LICENSE)
