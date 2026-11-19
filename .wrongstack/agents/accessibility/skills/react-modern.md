## `packages/webui` accessibility
- When adding `aria-label` to a JSX control, place it before any sibling prop whose expression contains `>` (for example, `stagedFiles.length > 0`). The AST-free scanner at `.temp_files/a11y-audit/scan.mjs` uses `<tag((?:=>|[^>])*)>` and truncates the captured attributes at that `>`, falsely reporting the control as unlabeled.
- Prefer `packages/webui/src/components/ui/dialog.tsx` or `packages/webui/src/components/ui/sheet.tsx` for modal UI; do not combine a visual overlay with `aria-modal` alone.
- Ensure modals provide focus entry, containment, and focus restoration before treating `aria-modal` as sufficient.

## `packages/webui` localization
- Mirror the target catalog’s terminology rather than translating literally. Use a small script to print one English key’s value across `src/i18n/locales/{de,en,es,fr,it,pt-BR,tr}` and reuse the sibling wording: pt-BR uses `função` for “role” and `habilidade` for “skill,” fr uses `compétence` for “skill,” and tr uses `pano` for “board.”
- Insert new keys beside related keys in the namespace object. Rewrite all seven catalogs with `JSON.stringify(obj, null, 2) + '\n'`; they round-trip byte-identically through this serialization, keeping the diff purely additive.

## `packages/tui` theme preview budget
- Give each new `sections` entry in `packages/tui/src/components/theme-preview.tsx` a `cost` of 1 unless you re-prove `contentBudget = maxRows − 3`. Existing `sections` sum to 15, and `packages/tui/tests/theme-picker.test.tsx` caps the `maxRows: 20` frame at 19 lines, leaving one row of headroom.
- Do not use `cost` 2 or higher without re-proving the budget: `cost` 2 currently fails that test, while `cost` ≥3 hides the section below `maxRows` 21.
- Guard single-row rendering with `wrap="truncate-end"`.

## `packages/tui` contrast verification
- Measure palette-wide contrast/luminance through a MEASURE-gated printer test run under `npx vitest` in `packages/tui`, never a plain Node `.mjs`.
- Do not bypass `packages/tui/vitest.config.ts`: `packages/tui/src/theme-presets/options.ts` value-imports `@wrongstack/core/types`, which resolves only through those aliases.
