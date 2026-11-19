## Commands

- From the repository root, run `cd packages/webui && bun run vitest run tests/i18n/catalog-integrity.test.ts`; never use `pnpm`, which aborts with `Unsupported package manager specification (bun@1.4.5)`.
- Put throwaway audit helpers in `packages/webui/.temp_files/` with a `.cjs` extension, never `.js`: `packages/webui/package.json` sets `"type": "module"`, so `.js` fails with `ReferenceError: require is not defined in ES module scope`. Keep exploratory logic out of `tests/i18n/`.
- Use `git diff` and flatten HEAD with `git show HEAD:<file>`; compare flattened dotted key sets to identify exact `ADDED` / `REMOVED` / `CHANGED` keys instead of inferring intent from line numbers.

## Audit Scope

- Do not treat a passing `catalog-integrity.test.ts` as proof of translation or orphan coverage; it checks parity, empty strings, dangling `t()` references, and translator wiring. Restrict flatten-and-compare findings to changed keys; ignore the unchanged en-identical backlog. Also compare placeholders and locale-appropriate `_one` / `_other` / `_few` shapes.
- Exclude en-identical `no` in the `es` or `it` catalogs: it is the native word, not a gap. Also exclude `healthNo`-style yes/no pairs from en-identical heuristics.
- Flatten `packages/webui/src/i18n/locales/en/activity.json` before deriving paths; its dotted paths already carry `memoryManager.`, so never prepend that prefix and create `memoryManager.memoryManager.x` orphans.
- To find orphans, diff flattened catalogs against `git show HEAD:<file>`, grep `src` directly for each dotted key, and cross-check the count against one known-good reference. Do not assume `packages/webui/tests/i18n/catalog-integrity.test.ts` detects unreferenced keys.
- Resolve catalogs at `packages/webui/src/i18n/locales/<locale>/<namespace>.json`; derive namespaces from `.json` files, not locale directory names.

## Domain Checks

- Keep dangling-reference scans plural-aware: exclude `workspaceCount_one` / `workspaceCount_other` when bare `t('activity:techStack.workspaceCount')` is valid. Inspect `t(key, { count })` call sites, including `ContextBreakdownModal.tsx`, before flagging flat count keys.
- Treat a key absent from every locale as raw-key output: `packages/webui/src/i18n/index.ts` configures `fallbackLng` but no `parseMissingKeyHandler` or `saveMissing`.
- Flag changed flat `{{count}}` phrasing and count-plus-label JSX that can render “1 items” or “1 snapshots”; distinguish harmless `{ total }` or `{ tokens }` interpolation. Classify loanwords such as `tokens` or `mode` for translator confirmation rather than hard gaps.

## Cleanup

- Treat `packages/webui/.temp_files/` as shared: remove only exact files created this run; leave others such as `i18n-audit-activity.mjs`.
- In PowerShell, use `Remove-Item <file> -Force`; never use `del /q` or multiple bare filenames because `del` resolves to the `Remove-Item` alias. Via bash, prefer cmd.exe `del /q`; if the bulk-delete gate denies removal, stop and list exact files for leader cleanup instead of using `node rmSync`. Confirm your files have no `glob` matches afterward.
