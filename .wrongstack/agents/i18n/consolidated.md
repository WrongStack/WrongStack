## Audit Workflow

- From the repository root, run `cd packages/webui && bun run vitest run tests/i18n/catalog-integrity.test.ts`. Never use `pnpm` for this repository; it fails on the Bun package-manager pin with `Unsupported package manager specification (bun@1.4.5)`.
- Restore key parity before running custom comparisons. Read the complete missing-key output first so checks are not obscured by absent keys.
- Treat `catalog-integrity.test.ts` as authoritative for key parity, empty strings, dangling `t()` references, and translator wiring. A passing suite does not prove that non-English values are translated and does not detect catalog keys with no source reference.
- Build the exact change set before auditing: inspect `git diff`, obtain the baseline file with `git show HEAD:<file>`, flatten the baseline and working-tree catalogs into dotted key/value maps, and compare them to derive exact added, removed, and changed keys. Restrict custom findings to that set.
- Use a throwaway flatten-and-compare audit to check changed values for placeholder parity, English identity, and count/plural shape. Do not report the repository-wide English-identical backlog as part of a change-specific audit.
- For dangling references, compare the source `t()` spelling with the catalog keys actually added. Pluralized keys such as `workspaceCount_one` and `workspaceCount_other` may legitimately satisfy `t('activity:techStack.workspaceCount')`.
- Audit source orphans separately: flatten the catalog, compare it with `git show HEAD:<file>`, and grep `src` for each added dotted key. Cross-check the orphan script against a known-good reference before trusting its count.
- Never prepend `memoryManager.` to a key already flattened from `packages/webui/src/i18n/locales/en/activity.json`; the dotted path already carries it, and `memoryManager.memoryManager.x` is a false orphan.
- Re-read the source and active locale files immediately before reporting because another process may have changed them.

## Translation Review

- Before flagging a new value as untranslated or divergent, search adjacent keys and other namespaces for established house terminology. Reuse the locale’s canonical wording, gender, and register; for example, `settings.json` `statuslineModeDetailed` establishes “Detailed,” while `settings.json` `unavailable` establishes “Nicht verfügbar” and “No disponible.”
- Resolve ambiguous names to their full JSON path before auditing. Keys such as `debug.unavailable` and `systemPrompt.unavailable` can coexist under the same namespace and filename.
- Classify English-identical values by confidence:
  - Hard gaps: complete sentences or clearly untranslated prose matching English.
  - Translator-confirm items: shared words, loanwords, or short labels that may be valid in the target locale.
- Do not flag native-language matches such as Spanish or Italian `no`. Exclude `healthNo`-style yes/no pairs from English-identical gap heuristics.
- Compare non-English locales with each other, not only with English, to detect cross-locale copy-paste. Treat isolated native-word overlaps such as Spanish and Brazilian Portuguese `Cancelada` as coincidences unless context shows incorrect translation.
- In German catalogs, preserve formal-address consistency. Capitalize a formal possessive such as `Ihre Aufgaben` when surrounding text uses capitalized `Sie`-forms; lowercase `ihre` remains correct when it means “their.”

## Code and i18next Conventions

- Pass the complete countable phrase through `t(key, { count })` and provide `_one`/`_other` variants for agreement-sensitive text. Do not split the number and noun into adjacent JSX.
- Inspect the call site before diagnosing pluralization: `{ count }` triggers i18next plural selection, while interpolations such as `{ total }` or `{ tokens }` do not.
- With WebUI i18next `^26`, `t(key, { count })` may fall back to a flat key when plural variants are absent. A flat key is acceptable only for count-agnostic text such as `Review ({{count}})`; flag `{{count}} items` when the phrase requires plural agreement.
- Never use printf-style `%%` escaping for literal percent signs in i18next catalogs. Use a bare `%` or the established form `(%{{pct}})`.
- Keep WebUI `sidePanel.*` description keys aligned with the `Activity` union in `packages/webui/src/stores/ui-store-types.ts`. The lookup in `packages/webui/src/components/SidePanel/index.tsx` is flat: ``t(`activity:sidePanel.${activeActivity}`)``.
- Type translator props as `(key: string, opts?: Record<string, unknown>) => string`; avoid `t: any` and untyped translator destructuring.

## Project Facts

- WebUI catalogs live under `packages/webui/src/i18n/locales/<locale>/<namespace>.json`. Shipped locales include `de`, `en`, `es`, `fr`, `it`, `pt-BR`, and `tr`; common namespaces include `activity`, `settings`, `setup`, `chat`, `commandPalette`, and `toasts`.
- Derive namespaces from `.json` filenames within one locale directory, not from locale-directory names.
- `packages/webui/src/i18n/index.ts` configures `fallbackLng` but no `parseMissingKeyHandler` or `saveMissing`; a key missing from every locale renders as its raw path.

## Tooling and Cleanup

- Write throwaway audit scripts under `packages/webui/.temp_files/` with a `.cjs` extension. The WebUI package is `"type": "module"`, so a `.js` helper using `require` fails with `ReferenceError: require is not defined in ES module scope`.
- Treat `packages/webui/.temp_files/` as shared. Delete only exact files created during the current run; leave other agents’ files untouched.
- In PowerShell, remove an exact throwaway file with `Remove-Item <file> -Force`. PowerShell `del` is an alias and does not accept the cmd.exe `/q` form or multiple bare filenames.
- In cmd.exe invoked through the bash tool, prefer `del /q "<exact-file>"`; confirm removal with `glob` for that exact path. If deletion is denied, report the precise leftover path for cleanup.
- If `read` suppresses a locale JSON re-read as unchanged, stop retrying and use a line-anchored grep such as `^ "`. On Windows, use `**/activity.json` or a direct file path because `*/activity.json` may silently match nothing.
- Do not rely on Unix `tail` in the bash tool. Redirect long output to a project-local file and inspect it with targeted grep patterns. Do not assume a grep limit above roughly three content lines is reliable.
- For add-only JSON edits, anchor on a unique existing key and preserve comma termination. If inserting after an object’s final key, add the required trailing comma to the previous entry.

## Reporting

- Report only actionable findings for the changed key set. Include the full dotted catalog path, locale, classification, evidence, established house term when relevant, and source call site.
- Distinguish hard translation gaps from translator-confirm items, and state clearly when orphan detection or semantic review remains unverified.
- Never claim that the baseline proves translation completeness or orphan-free catalogs.