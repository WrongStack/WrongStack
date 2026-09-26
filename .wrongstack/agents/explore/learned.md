# Learned instructions for `explore`

> Project-specific learning data for the `explore` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-09-25T19:10:34.188Z; skill=codebase-navigation; applied=3; wins=3; skipped=5; skippedWins=5 -->
- **When finding importers of a WebUI component, grep the import-specifier pattern (`from ['"].*ComponentName['"]|import\(.*ComponentName`) rather than the bare basename — a bare-basename grep for `DependencyDetail` returned 21+ false hits from i18n locale keys like `missingDependencyDetail` and unrelated identifiers. Pair it with `codebase-incoming-calls` only to confirm the count, since its import rows can be attributed to the wrong symbol at that line.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `from ['"].*ComponentName['"]|import\(.*ComponentName`
  - *How:* `DependencyDetail`
  - *How:* `missingDependencyDetail`
  - *How:* `codebase-incoming-calls`

---
*Last capture: 2026-09-25T19:10:34.188Z · 1 entries*
