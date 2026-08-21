# Finding: Dynamic code execution (`new Function`) in test code

**Severity:** Low
**Category:** Security hygiene / CSP compatibility

## Description

`packages/tools/tests` constructs functions dynamically via `new Function(...)`. This is test-only (no production `eval`/`new Function` was found in any `packages/**/src` file — the only hits were scanner fixtures and these two tests), but it is worth tracking because:

1. If these tests are ever bundled or executed in a browser-like environment (e.g. Vitest browser mode), a strict CSP (`script-src 'self'`) will block them.
2. It sets a copy-paste precedent that could leak into production code.

## Evidence

Verified via ripgrep pattern `\beval\(|new Function\(` over `packages/**/*.{ts,js}`:

- `packages/tools/tests/tool-summary.parity.test.ts:19`
  ```ts
  const browserSummarize = new Function(
  ```
- `packages/tools/tests/tool-diff.test.ts:105`
  ```ts
  const bs = new Function(
  ```

Both appear to re-evaluate browser-bundled JS strings to compare Node and browser implementations of `tool-summary` / `tool-diff`. The corresponding production files (`packages/tools/src/tool-summary.ts`, `tool-diff.ts`) contain generated JS source strings that are *shipped* as text — they are only evaluated in a real browser at runtime, which is acceptable.

All other matches were inside security-scanner fixtures (`packages/plugins/tests/security-hotspot-scanner.test.ts`, `packages/security-scanner/tests/scanner-edge.test.ts`, `packages/tools/tests/security-ast-scan-tool.test.ts`) — intentional vulnerability samples, not findings.

## Proposed remediation

1. Prefer importing the shared implementation directly in both environments instead of re-`new Function`-ing a string; if the point is to prove the shipped JS string is valid, keep it but add a comment stating why dynamic evaluation is required.
2. Add an architecture/CI guard asserting no `eval(`/`new Function(` appears under `packages/**/src` (the repo already has `architecture/exceptions.json` governance — add this as a baseline rule).
