## TUI animation (`packages/tui/tests/`)
- Follow `banner-formation.test.tsx`: pair `vi.waitFor(..., { timeout, interval })` with a `vi.spyOn(Date, 'now')` frozen clock. Real timers still drive Ink repaints and polling, so fixed-ms `settle()` waits are the flaky construct — judge frame determinism from the mocked clock value, not wall time, and don't flag the `waitFor` form as a hang risk.

## Browser smoke (`packages/vibeui/tests/browser-smoke.mjs`)
- Confirm theme-contrast tokens exist in `packages/vibeui/src/app/globals.css` before canvas assertions; a missing token makes `ctx.fillStyle` silently reuse its prior color.
- Never assert `/transparent/` on `getComputedStyle(el).outlineColor` — Chromium returns `rgba(0, 0, 0, 0)`; parse alpha instead.
- Drive strict counts (`.workspace-notes article`, skills listbox options) from a single socket; extra clients trip the broadcast loop in `wss.on('connection')`.
- Allow `page.clock.install()` only for server-push-driven or synchronous steps; flag reliance on app-side real timers.

## Mocks & fixtures
- Mirror production import shapes: `packages/cli/src/boot/tui-project-spawn.ts` uses named `{ spawn }` from `node:child_process` — mock that export, stub only the touched `child.on`/`child.unref`, emit awaited events, and check for unmocked throws or early returns.
- Build `initialize` fixtures in `packages/mcp/tests/server.test.ts` from `SUPPORTED_PROTOCOL_VERSIONS` (`packages/mcp/src/constants.ts`); reserve `'2025-11-25'` for mismatch cases. Assert dispatch against `packages/mcp/src/server-dispatch.ts`, not review text.

## Platform gotchas
- Under `bun --bun vitest` on Windows, reject `node -e "<code>" -- <args>` / `-p` probes: the `node.exe` shim drops the first positional. Use a `.cjs` sandbox at `argv[1]` asserting `process.argv.slice(2)` (`packages/tools/tests/exec-autonomy.test.ts`).
- In `packages/tools/tests/dead-code-engine.test.ts`, read the apply-time gate in `packages/tools/src/dead-code/fix.ts` before crediting `verify: 'none'` + `verifyCommand` cases — a skipped command leaves `rolledBack` untested.
