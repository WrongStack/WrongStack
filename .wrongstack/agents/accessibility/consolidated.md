## Accessible WebUI Controls

- When JSX in `packages/webui` is checked by `.temp_files/a11y-audit/scan.mjs`, place `aria-label` before any sibling prop whose expression contains `>` (for example, `stagedFiles.length > 0`); the scanner’s AST-free `<tag((?:=>|[^>])*)>` regex truncates at that character and can falsely report the control as unlabeled.

## Modals

- Prefer `packages/webui/src/components/ui/dialog.tsx` or `packages/webui/src/components/ui/sheet.tsx` for modal UI; a visual overlay plus `aria-modal` alone is insufficient—modals must provide focus entry, containment, and focus restoration.

## Contrast Testing

- Measure palette-wide contrast and luminance through a `MEASURE`-gated printer test run with `npx vitest` in `packages/tui`, not plain Node `.mjs`; `packages/tui/src/theme-presets/options.ts` value-imports `@wrongstack/core/types`, which resolves only through the aliases in `packages/tui/vitest.config.ts`.