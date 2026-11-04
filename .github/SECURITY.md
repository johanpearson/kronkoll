# Security policy

Kronkoll handles real bank data for one household, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/johanpearson/kronkoll/security/advisories/new)
instead. You will get an answer as soon as possible, usually within a week.

Do not include real bank data, tokens or keys in the report.

## Scope

Only the latest version on `main`, which is what is deployed, is supported.

## How the app is protected

- Read-only access to the bank. There is no code that can make payments.
- All pages and the API sit behind Cloudflare Access.
- Secrets live only in Cloudflare and in protected GitHub environments, never in the repository.
- Every change passes secret scanning, pinned GitHub Actions and the full test suite before it is deployed.
