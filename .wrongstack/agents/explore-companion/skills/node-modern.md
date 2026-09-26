## Vitest invocations

- The root `vitest.config.ts` excludes `packages/webui/**`, so a root-level `vitest run` that passes says nothing about webui — never cite it as verification there. Run webui suites with `cd packages/webui && npx vitest run <file>`.
- Inside `packages/webui/vitest.config.ts` two projects split the surface: `browser-jsdom` globs `tests/**/*.test.{ts,tsx}` (excluding `tests/server/**`), so even DOM-free unit tests such as `tests/components/chat-view-auto-collapse.test.ts` execute under jsdom; `tests/server/**` belongs to the node project. Do not assume a plain `.ts` unit test escapes jsdom.
- `packages/cli/tests/hq-dashboard.test.ts` runs only via `pnpm --filter @wrongstack/cli test:hqdash`, which uses `packages/cli/vitest.hqdash.config.ts`.
- Before naming any command, read the `exclude` list in the root config and the `test`/`typecheck` scripts in the touched package's `package.json`; report a surface as verified only when your named command actually executes it.

## Capturing proof

- For a "run tests / capture proof" todo, write captured output to `.reports/release-check-matrix/*.log`, matching the naming already used there; derive the narrowest legitimate filter from the package's `test`/`typecheck` scripts rather than inventing a new invocation.

## Probing leader todos

- The session todo store is runtime state with no file backing: `glob .wrongstack/**/*todo*` finds nothing. Fall back to mtime-ordered `glob` over `packages/*/src` plus `git diff HEAD` as ground truth.
- Treat the auto-mined `.wrongstack/domain-terms.md` list as per-request boilerplate, never as signal about the leader's current work.

## `submit_result` payloads

- Keep every field pure ASCII; em-dashes and arrows (—, ⇒) correlate with "Invalid report" schema rejections, while the same content rewritten in ASCII passes.
- Keep payloads small — roughly ≤7 short `findings` and ≤3 `files_examined`. Oversized reports are rejected with the misleading "summary/findings/… are required" error even when every field is present and ASCII; treat that error as a size problem first, trim, and retry.
