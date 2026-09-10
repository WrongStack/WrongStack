## Commands

- Run the storage slice without a build step: `npx vitest run packages/core/tests/storage` from repo root. The root `vitest.config.ts` aliases `@wrongstack/core` (and extracted packages) to source, so stale dist never affects results. Don't reach for the package `test` script instead — it runs all of `packages/core/tests`, broader than storage.

## Shell on this host

- The Windows shell has no `grep`/`tail`, and `node -e "..."` with regex or special chars breaks under cmd quoting. For anything nontrivial, write a temp `.mjs` under `.temp_files/`, run `node <script>`, delete it afterward; use the `grep` tool for content searches.
- Never capture an exit code via `& echo %ERRORLEVEL%` in a compound cmd line — it expands before execution. Write output to a file and grep the summary instead.

## Pitfalls

- In crash-simulation tests using a real `FileSessionWriter` (`packages/core/tests/storage/`), `writer.close()` finalizes the summary sidecar, re-stamping `endedAt` and `outcome:'completed'`. Place `close()` after every assertion that reads crash-state via `store.load()` — or fabricate raw JSONL instead of opening a writer. Always close the writer: an unclosed writer reproduces the A-14 leak class ("Closing file descriptor on garbage collection", a future Node hard error).
- Counting `as never`/`as any` casts by regex requires cast-form patterns like `\bas never[,;\])}]`. Bare word matches pick up prose ("was never claimed") and inflate counts ~10% in `packages/tui` tests.

## Reporting

- If `submit_result` returns the generic "required / confidence must be 0..1" error despite all fields being present and in range, retry at most once with a compacted payload. If it still refuses, the channel-side validator is rejecting all payloads — deliver the report in the final text response instead of looping.
