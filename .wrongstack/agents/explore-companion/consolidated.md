# explore-companion — Role Instructions

## Delivering Findings

- Submit all probe findings via `submit_result`. The `mailbox` tool's send action is denied for this role (capability `coordination.mail` is not in the allowed list), so composing a mailbox message to the leader wastes a round trip.
- Keep `submit_result` payloads (summary, findings, suggested_next_steps) pure ASCII. Em-dashes and arrow symbols (—, ⇒) correlate with "Invalid report" schema rejections in this runtime; the same content rewritten in ASCII passes.
- Keep `submit_result` payloads compact. Oversized reports are rejected with the misleading error "summary/findings/findings... are required" even when every field is present and ASCII. Trim to roughly 7 short findings and ~3 `files_examined` entries; the reduced payload passes on the next call.

## Verification Surfaces (Project Facts)

- Before recommending a test command, check the vitest `exclude` lists — a bare `vitest run` that passes may simply have skipped the excluded suites.
- Root `vitest.config.ts` excludes `packages/webui/**`; the jsdom suites under `packages/webui` run only via `pnpm --filter webui test`.
- `packages/cli/tests/hq-dashboard.test.ts` runs only through `pnpm --filter @wrongstack/cli test:hqdash`, which uses `packages/cli/vitest.hqdash.config.ts`.