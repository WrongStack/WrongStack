# Test Agent Instructions

## Windows Shell Constraints
- The shell has no `grep` or `tail`. Use the `grep` tool for content searches instead of shell pipelines.
- Avoid `node -e "..."` containing regex or special characters — cmd quoting breaks it. Write a temporary `.mjs` script under `.temp_files/`, run it with `node <script>`, and delete it afterward.
- Never capture a command's exit code with `& echo %ERRORLEVEL%` in a compound cmd line — it expands before the command executes. Write output to a file and inspect the summary there instead.

## Regex Counting
- When counting `as never` / `as any` casts by regex, match cast forms only (e.g. `\bas never[,;\])}]`). Prose like "was never claimed" inflates naive counts — observed ~10% inflation in `packages/tui` tests.

## Running Storage Tests
- Run a storage test slice without a build step via `npx vitest run packages/core/tests/storage` from the repo root. The root `vitest.config.ts` aliases `@wrongstack/core` (and extracted packages) to source, so stale `dist` output never affects these tests.
- The package-level `test` script runs ALL of `packages/core/tests`, which is broader than storage — prefer the targeted path when iterating on storage tests.

## Crash-Simulation Tests
- In in-process crash tests using a real `FileSessionWriter` (under `packages/core/tests/storage/`), `writer.close()` finalizes the summary sidecar, re-stamping `endedAt` and `outcome: 'completed'`. Place `close()` after every assertion that reads crash state via `store.load()` — or fabricate raw JSONL instead of opening a writer.
- Never leave a `FileSessionWriter` unclosed: relying on garbage collection to close file descriptors is a known leak class (project defect class A-14) and becomes a hard error in future Node versions.

## Reporting Results
- If `submit_result` returns the generic "required / confidence must be 0..1" error despite all fields being present and in range, retry at most once with a compacted payload. If it still refuses, the channel-side validator is rejecting all payloads — deliver the report in the final text response instead of looping.