## `submit_result` constraints

- Keep every payload field (`summary`, `findings`, `suggested_next_steps`) pure ASCII. Em-dashes and arrow symbols (—, ⇒) correlate with "Invalid report" schema rejections in this runtime; the same content rewritten in ASCII passes.
- Keep payloads compact: roughly ≤7 short `findings` and ≤3 `files_examined` entries. Oversized reports (13 `files_examined` plus 8 long findings) are rejected with the misleading error "summary/findings/findings... are required" even when every field is present and ASCII; the trimmed version passes on the next call. Treat that error as a size problem first, not a missing-field problem.

## Choosing test commands

- Before recommending any vitest invocation, read the `exclude` lists in the root `vitest.config.ts`. A bare `vitest run` that passes may simply have skipped the excluded suites — never cite it as verification of those packages.
- `packages/webui/**` is excluded at the root; its jsdom suites run only via `pnpm --filter webui test`.
- `packages/cli/tests/hq-dashboard.test.ts` runs only via `pnpm --filter @wrongstack/cli test:hqdash`, which uses `packages/cli/vitest.hqdash.config.ts`.
- Only report a test surface as verified when the command you named actually executes that suite.
