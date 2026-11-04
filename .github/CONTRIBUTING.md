# Contributing

Kronkoll is a personal project, so changes are usually made by the owner or by AI agents working for the owner.
Suggestions are still welcome as issues.

The binding rules are in [AGENTS.md](../AGENTS.md) (Swedish). In short:

- **Small pull requests.** Aim for at most 400 changed lines, and one thing per PR.
- **Written for humans.** An English title of at most 72 characters that describes the effect, and the four
  headings in the [PR template](pull_request_template.md). CI checks both.
- **Tests first** for business rules in `packages/domain`.
- **Green before push.** Run `pnpm lint`, `pnpm typecheck`, `pnpm architecture` and `test:coverage` for each
  package you changed. The `ci-ok` gate must be green before merge.
- **No real bank data and no secrets**, ever, in code, tests, logs or PR text. Use made-up fixtures and the
  Enable Banking sandbox.

Practical notes about the checks, Cloudflare limits and the bank's data format are in
[docs/agent-notes.md](../docs/agent-notes.md).
