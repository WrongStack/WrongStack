## `submit_result` constraints

- Keep every payload field (`summary`, `findings`, `suggested_next_steps`) pure ASCII. Em-dashes and arrow symbols (—, ⇒) correlate with "Invalid report" schema rejections in this runtime; the same content rewritten in ASCII passes.
- Keep payloads compact: roughly ≤7 short `findings` and ≤3 `files_examined` entries. Oversized reports (13 `files_examined` plus 8 long findings) are rejected with the misleading error "summary/findings/findings... are required" even when every field is present and ASCII; the trimmed version passes on the next call. Treat that error as a size problem first, not a missing-field problem.

## Choosing test commands

- Before recommending any vitest invocation, read the `exclude` lists in the root `vitest.config.ts`. A bare `vitest run` that passes may simply have skipped the excluded suites — never cite it as verification of those packages.
- `packages/webui/**` is excluded at the root; its jsdom suites run only via `pnpm --filter webui test`.
- `packages/cli/tests/hq-dashboard.test.ts` runs only via `pnpm --filter @wrongstack/cli test:hqdash`, which uses `packages/cli/vitest.hqdash.config.ts`.
- Only report a test surface as verified when the command you named actually executes that suite.

- When probing a leader's in-progress todo, first check whether the session todo store is materialized on disk (`glob .wrongstack/**/*todo*`) — in WrongStack it is runtime state with no file backing, so the probe must fall back to mtime-ordered `glob` over `packages/*/src` plus `git diff HEAD` as ground truth; treat the auto-mined `.wrongstack/domain-terms.md` jargon list as boilerplate present in every request, never as signal about the leader's current work. (anchors: `glob .wrongstack/**/*todo*`, `glob`, `packages/*/src`, `git diff HEAD`, `.wrongstack/domain-terms.md`) [applied 40×, 40 ok]
- When probing a WrongStack "run tests / capture proof" todo, derive the verification surface from three anchors before reporting commands: `.reports/release-check-matrix/*.log` (the repo's existing proof-artifact convention — check its filenames for where captured output belongs), the `test`/`typecheck` scripts in the touched package's `package.json` (they define the narrowest legitimate filter), and the `exclude` list in root `vitest.config.ts` (a green bare `vitest run` may simply have skipped webui, hq-dashboard, and status-bar suites). (anchors: `.reports/release-check-matrix/*.log`, `test`, `typecheck`, `package.json`, `exclude`, `vitest.config.ts`, `vitest run`) [applied 82×, 82 ok]

---
*Distilled 2026-08-21T12:26:51.245Z · 2 new directives*
