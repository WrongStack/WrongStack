# Learned instructions for `explore-companion`

> Project-specific learning data for the `explore-companion` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-09-25T19:33:52.560Z; skill=codebase-navigation; applied=8; wins=8; skipped=2; skippedWins=2 -->
- **- When counting i18next consumers of a namespace, grep the key prefix as `['"]<ns>:` (quote before, colon after) — e.g. `rg "['\"]activity:" packages/webui/src`. A pattern like `activity:['"]` (quote after the colon) can only match when the first key segment is itself quoted and silently returns zero for `t('activity:nav.chat')`, producing a false "no consumers" conclusion. Never report zero callers from a single novel regex; re-test the pattern shape before stating a count. - Locale JSON files in `packages/webui/src/i18n/locales/<lng>/<ns>.json` have no static importers in src; the single load path is the `resourcesToBackend` dynamic import at `packages/webui/src/i18n/index.ts` (`import(\`./locales/${lng}/${ns}.json\`)`), with `activity` and `settings` as deferred chunks pre-fetched via `i18n.loadNamespaces`. Blast radius for editing any en locale file is: key parity across all `SUPPORTED_LNGS` siblings, enforced by `packages/webui/tests/i18n/catalog-integrity.test.ts`, plus direct JSON imports in tests.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `['"]<ns>:`
  - *How:* `rg "['\"]activity:" packages/webui/src`
  - *How:* `activity:['"]`
  - *How:* `t('activity:nav.chat')`
  - *How:* `packages/webui/src/i18n/locales/<lng>/<ns>.json`
  - *How:* `resourcesToBackend`
  - *How:* `packages/webui/src/i18n/index.ts`
  - *How:* `import(\`
  - *How:* `)`
  - *How:* `activity`
  - *How:* `settings`
  - *How:* `i18n.loadNamespaces`
  - *How:* `SUPPORTED_LNGS`
  - *How:* `packages/webui/tests/i18n/catalog-integrity.test.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-09-25T20:07:49.059Z; skill=codebase-navigation; applied=1; wins=1 -->
- **When counting consumers of the `activity` i18n namespace in `packages/webui`, count `t('activity:` literals (pattern `['"]activity:`), never `useTranslation('activity')` — it returns 0 because all components go through the `useAppTranslation()` wrapper exported from `@/i18n` (`packages/webui/src/i18n/index.ts`). Also verify every `activity\.json` grep hit is a real import/require: `packages/webui/src/components/TaskActivityTimeline.tsx` builds a `` `${...}-activity.json` `` filename that collides with the locale-file path.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `activity`
  - *How:* `packages/webui`
  - *How:* `t('activity:`
  - *How:* `['"]activity:`
  - *How:* `useTranslation('activity')`
  - *How:* `useAppTranslation()`
  - *How:* `@/i18n`
  - *How:* `packages/webui/src/i18n/index.ts`
  - *How:* `activity\.json`
  - *How:* `packages/webui/src/components/TaskActivityTimeline.tsx`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-09-25T19:37:41.971Z; skill=codebase-navigation; applied=6; wins=6; skipped=3; skippedWins=3 -->
- **Before reporting the blast radius of a webui locale edit, read the three guards in `packages/webui/tests/i18n/catalog-integrity.test.ts` rather than reciting "parity" generically: key-set parity vs en (line ~80), blank/whitespace-value rejection (line ~105), and `t() references resolve` incl. `_one`/`_other` plurals (line ~118). Verify with `cd packages/webui && npx vitest run tests/i18n` — root vitest excludes the package.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/webui/tests/i18n/catalog-integrity.test.ts`
  - *How:* `t() references resolve`
  - *How:* `_one`
  - *How:* `_other`
  - *How:* `cd packages/webui && npx vitest run tests/i18n`

<!-- learned-stamp: category=convention; capturedAt=2026-09-25T19:40:05.363Z; skill=codebase-navigation; applied=5; wins=5; skipped=2; skippedWins=2 -->
- **When mapping a webui locale-file edit, also name `packages/webui/tests/i18n/deferred-namespaces.test.ts` (describes "B-13 — deferred i18n namespaces are NOT inlined" and "loaded via the backend") as a guard alongside catalog-integrity: it pins `activity`/`settings` to the lazy-chunk path, so any change that inlines or re-routes those namespaces breaks it even when key parity is intact.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/webui/tests/i18n/deferred-namespaces.test.ts`
  - *How:* `activity`
  - *How:* `settings`

---
*Last capture: 2026-09-25T20:07:49.059Z · 4 entries*
