# Bug-Hunter Agent Instructions

## Adjudication and live-source discipline

- Treat findings, proposed patches, and retractions as hypotheses. Validate live source, producer-to-consumer flow, covering tests, and explicit policy before editing.
- On retries or co-modified trees, reread the exact live call site before editing. If a fix is already present, or a guarded edit fails after external modification, report the finding as resolved with live anchors instead of reapplying or duplicating the change.
- Before citing a path, inspect its live state with `git status --short -- <path>` and `git diff -U0 -- <path>`. Separate unrelated peer diagnostics from the reviewed change.
- Do not infer bypasses, missing guards, stale dependencies, or file-shape problems from rendered diffs alone. For one-liner or missing EOF-newline claims, inspect exact bytes, e.g. `[System.IO.File]::ReadAllBytes(...)` last bytes. For plugin trust pin claims, first check whether the path takes shared-root import-closure hashing or plugin-directory manifest hashing in `packages/core/src/plugin/trust.ts`; single-file pins are not automatically bypasses.
- For alleged missing props, modules, exports, duplicate identifiers, or undeclared identifiers, search actual call sites and package-wide symbols, then run a scoped typecheck. A clean compile refutes only the compile claim within the checked scope, not runtime behavior.

## Race, lifecycle, and state contracts

- Decrement lifecycle refcounts in a `finally` around awaited RPCs, not only on success. In `packages/core/src/session-catalog/registry.ts`, success-only decrement can leave an IPC binding open when `activate_reservation` rejects.
- Before adding a `close()` path that rejects the in-flight connect promise in `packages/core/src/session-catalog/client.ts`, inspect `connectWithElection()` for an `explicitlyClosed` guard. The election loop can otherwise `spawnDetached()` a catalog daemon after `close()` returns.
- Resolve tool write-target paths for project-relative gates using `ctx.workingDir ?? ctx.cwd`, matching `resolvePath()` in `packages/tools/src/_util.ts`. Using `ctx.cwd` alone diverges after `set_working_dir()` and can fire path-based gates against the wrong file.
- In `packages/core/src/hq/approval-bridge.ts`, `tool.confirm_resolved` is emitted synchronously by resolvers, and the `offResolved` listener can announce even when `pending` has already been deleted. New announce sites must dedupe with a bus-announced id flag; do not remove either existing path. Treat a lone `packages/core/src/storage/todos-checkpoint.ts` TS2454 in `packages/core` typecheck output as pre-existing out-of-scope noise unless `git status --short -- packages/core/src/storage/todos-checkpoint.ts` shows the exact path changed.
- For race and state-transition claims, construct counterexamples from actual suspension points, guard subsumption, and write ordering. A promise-returning function body still executes synchronously until its first `await`.
- In stop, teardown, and lifecycle paths, capture in-flight flags at entry and inspect the synchronous prefix before the first `await`; synchronous listeners registered only after an await may miss emissions.
- Validate existence before acquiring leases so invalid input cannot hold a lease or hide a not-found condition.
- Check React dependency arrays and persisted-state effects before alleging optimistic flicker; an effect keyed to a persisted value does not rerun merely because an unrelated local override changes.

## Verification and ownership

- Prefer targeted Bun-native checks: `bunx vitest run <covering files>` and `bunx biome check <files>`. Use `bunx biome check --write <files>` only for necessary formatting. Avoid repo-wide runs for narrow changes.
- Typecheck the reviewed package with `node node_modules/typescript/bin/tsc --noEmit --pretty false -p <package>/tsconfig.json`. Use `packages/core/tsconfig.test.json` for core test typing. For remaining diagnostics, attribute them to specific files with `git status --short -- <path>` before letting a non-zero exit fail a review gate.
- Establish disputed test provenance with `git status --short` and `git log --oneline -5 -- <test file>`. Untracked status alone does not establish authority. Preserve unaffected assertions and add focused regressions when restoring a lost contract.
- If failures or test counts drift after concurrent edits, inspect affected paths, let peer changes settle, and rerun verification rather than treating the unstable snapshot as authoritative.

## Project-specific durable rules

- When adding a TUI-picker `Config` field whose parent section is denied for in-project configs, route it through the profile-only path. Check `IN_PROJECT_ALLOWED_KEYS` / `KNOWN_DENIED_IN_PROJECT` in `packages/core/src/storage/config-loader/in-project-policy.ts` and `PROJECT_SAFE_FIELDS` in `packages/cli/src/settings-menu.ts`, then add the key to `hasProfileOnlySettings` and write it in the `forceGlobal` branch of `persistConfigSetting`. A top-level key absent from `PROJECT_SAFE_FIELDS` can be silently stripped under `configScope: 'project'` while the in-memory `ConfigStore` still shows the new value.
- Before declaring a markdown renderer or ArtifactLink React UI XSS-clean, inspect link components for URL-scheme validation, especially `javascript:` hrefs. Absence of `dangerouslySetInnerHTML` is insufficient. Reuse the `safeLoginUrl` allowlist pattern from `provider-manager.tsx` when rendering agent-controlled hrefs in components such as `markdown-content.tsx`.
- Sandbox `Tool` gates in `packages/core/src/sandbox/wrap.ts` must fail closed for both `execute` and `executeStream`, resolving per-agent policy on each call.