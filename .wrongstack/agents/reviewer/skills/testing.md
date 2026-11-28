## Failure-surface coverage
- For "I/O errors still reject", a read-only failure test is insufficient: in `packages/coordination/tests/file-author-tracker.test.ts` the EISDIR case exercises only `fs.readFile`. Mock `fs.copyFile` to reject, assert the promise rejects with that error, and assert the original corrupt file still holds its original bytes.

## CSS narrowing
- Compute specificity explicitly for `:is(A, B)` — it adopts its most specific argument, so `:is(.modal, .model-catalog-settings) .model-draft-notice p` (0,2,1) still outranks the removed `.model-draft-notice p` (0,1,1). Grep the component's root `className` ancestor to prove every render site still matches; the diff alone doesn't prove coverage.

## TUI animation (`packages/tui/tests/`)
- Follow `banner-formation.test.tsx`: `vi.waitFor(..., { timeout, interval })` with a `vi.spyOn(Date, 'now')` frozen clock. Real timers drive Ink repaints and polling, so fixed-ms `settle()` waits are the flaky construct. Judge frame determinism from the mocked clock, not wall time; don't flag `waitFor` as a hang risk.

## Browser smoke (`packages/vibeui/tests/browser-smoke.mjs`)
- Confirm theme-contrast tokens exist in `packages/vibeui/src/app/globals.css` before canvas assertions; a missing token makes `ctx.fillStyle` silently reuse its prior color.
- Never assert `/transparent/` on `getComputedStyle(el).outlineColor` — Chromium returns `rgba(0, 0, 0, 0)`; parse alpha.
- Drive strict counts (`.workspace-notes article`, skills listbox options) from a single socket; extra clients trip the `wss.on('connection')` broadcast loop.
- Allow `page.clock.install()` only for server-push-driven or synchronous steps; flag reliance on app-side real timers.

## Mocks & fixtures
- Mirror production import shapes: `packages/cli/src/boot/tui-project-spawn.ts` uses named `{ spawn }` from `node:child_process` — mock that export, stub only the touched `child.on`/`child.unref`, emit awaited events, check for unmocked throws or early returns.
- Build `initialize` fixtures in `packages/mcp/tests/server.test.ts` from `SUPPORTED_PROTOCOL_VERSIONS` (`packages/mcp/src/constants.ts`); reserve `'2025-11-25'` for mismatch cases. Assert dispatch against `packages/mcp/src/server-dispatch.ts`.

## Platform gotchas
- Under `bun --bun vitest` on Windows, reject `node -e "<code>" -- <args>` / `-p` probes: the `node.exe` shim drops the first positional. Use a `.cjs` sandbox at `argv[1]` asserting `process.argv.slice(2)` (`packages/tools/tests/exec-autonomy.test.ts`).
- In `packages/tools/tests/dead-code-engine.test.ts`, read the apply-time gate in `packages/tools/src/dead-code/fix.ts` before crediting `verify: 'none'` + `verifyCommand` cases — a skipped command leaves `rolledBack` untested.
