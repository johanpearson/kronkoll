# Instruktioner för GitHub Copilot

Följ [`AGENTS.md`](../AGENTS.md) i repots rot. Den är bindande för alla som bidrar, även AI-agenter.
Läs sedan [`docs/agent-notes.md`](../docs/agent-notes.md) för praktiska lärdomar om kontrollerna,
Cloudflares gränser, Skandias dataformat och öppna trådar.

Kort: små PR:er, en i taget, engelsk titel på högst 72 tecken och de fyra rubrikerna i PR-mallen. TDD för
domänlogik. Kör lint, typecheck, architecture och `test:coverage` per paket innan push. Skapa aldrig en PR
som ägaren inte bett om, och merga aldrig själv. Ingen riktig bankdata i kod, tester, loggar eller PR-texter.
