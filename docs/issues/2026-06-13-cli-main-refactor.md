# Split `packages/cli/src/cli-main.ts` (2,424 lines) into focused boot phases

**Filed:** 2026-06-13
**Status:** Open
**Priority:** Medium (long-running, blocked on the test-extraction harness)
**Effort estimate:** 4–6 days, sequenced into 7 PRs
**Risk:** High — the file owns the entire CLI boot path and zero integration test covers its end-to-end shape today

## Problem

`packages/cli/src/cli-main.ts` is 2,424 lines (one of four files in the
repo over 2,000 — `tui/app.tsx: 5,671`, `cli/webui-server.ts: 3,407`,
`webui/server/index.ts: 3,104`, and this one). The June 5 refactor
plan (1.2) called for splitting it but no PRs have landed yet. The
single `main()` function in this file now contains:

- argv parsing and `NODE_ENV=production` boot defaulting (lines 112–129)
- the full `createDefaultContainer` wiring (lines 130–250)
- every `ReplOptions` callback — `onMcp`, `onYolo`, `onAutonomy`,
  `onEternalStart`, `onEternalStop`, `onSuggestions`, `onNextPredict`,
  `onExit`, and ~70 more (lines ~700–2,080)
- the eternal-autonomy engine lazy-instantiation
- the multi-agent host binding
- the goal / session / mailbox / worktree / brain side-channel wiring
- the recovery prompt and update-notice orchestration
- the webui-server start / TUI launch / REPL dispatch fork

With everything in a single function, every new slash command, every
new permission callback, and every new subscription requires editing
the same ~2,000-line block of closure-captured mutable state. The
function has no integration test — only a handful of
`pre-launch.test.ts` / `boot-config.test.ts` unit tests cover the
adjacent boot helpers, and nothing exercises the full `main(argv) →
execute(...) → REPL/TUI dispatch` path.

## Why this matters

1. **The `tui/app.tsx` decomposition is already running.** That work
   will cascade into `cli-main.ts`: every new TUI-side effect needs a
   matching callback in the `ReplOptions` object, which means another
   closure in `main()`. Splitting `cli-main.ts` first is a
   prerequisite for finishing the TUI refactor cheaply.
2. **Three of the four >2,000-line files are untracked.** Only
   `tui/app.tsx` has a sequenced decomposition plan
   (`docs/issues/2026-06-13-tui-app-refactor.md`, 8 PRs). The other
   three — `cli-main.ts`, `webui-server.ts`, `webui/server/index.ts` —
   drift in silence, growing every week. Each new feature adds 50–200
   lines to whichever is the closest match, accelerating the
   regression. The file-size gate (`scripts/check-file-size.mjs`)
   prints a warning but does not block the merge.

## Proposed approach (sequenced, one PR per step)

The same `PR-0 characterization test → extract → verify` template
from the tui-app refactor applies, adapted for a non-React file.
`cli-main.ts` is a `main()` function, not a component, so the
extraction unit is a **boot phase** (a function that takes the
running `BootContext` and returns a typed result), not a custom hook.

### PR 0 — Baseline boot-shape integration test (must come first)

Add a vitest test that invokes `main(argv)` with a stub
`@wrongstack/runtime` container, a stub `Agent`, and a stub TUI/REPL
host. The test should:

- Call `main()` with `argv = ['node', 'wstack', '--help']` and assert
  it returns 0 without writing to stdout.
- Call `main()` with a flag combination that short-circuits to
  `runPluginManagementCommand` and assert the stub was invoked with
  the expected `argv` slice.
- Snapshot the `ReplOptions` shape (function references) that
  `main()` would hand to a stub REPL — call it with a `--repl-test`
  flag (added behind `process.env['WSTACK_BOOT_INSPECT'] === '1'`) that
  serializes the constructed `ReplOptions` to JSON-serializable form
  and returns it as the exit code.

This is the safety net for everything that follows. **All later PRs
must keep this test green and re-run it manually after every phase
extraction.** No test → no extraction.

The June 5 plan didn't include this step; it's the lesson from the
tui-app refactor (2026-06-13): "Big-file refactors need
characterization tests first, not after."

### PR 1 — `boot/env-defaults.ts` (low risk)

Extract the `NODE_ENV=production` defaulting (lines 113–129) and the
`WRONGSTACK_NODE_ENV_DEFAULTED` marker logic into
`boot/env-defaults.ts`. The function is `applyNodeEnvDefaults(): void`,
called from `main()`. Pure move + named-export; no behavior change.

This is the same pattern as `tui/src/hooks/use-keyboard-handling.ts`
in the tui refactor: an inline block becomes a named module with
a test of its own.

### PR 2 — `boot/container-wiring.ts` (low risk)

Extract lines 167–250 (PathResolver, EventBus, `createDefaultContainer`
call) into `boot/container-wiring.ts`. Returns
`{ container, events, pathResolver }`. The `main()` function shrinks
by ~80 lines; no behavior change. `boot-config.test.ts` already covers
`createDefaultContainer` directly, so this PR is mostly mechanical.

### PR 3 — `boot/replay-wiring.ts` (low risk)

Extract the `--replay` / `--record` handling (lines 192–250) into
`boot/replay-wiring.ts`. The block already follows the
"check flag → bind `ReplayProviderRunner` under `TOKENS.ProviderRunner`"
pattern that other phases (e.g. `fleet-wiring.ts`) use. Move + test.

### PR 4 — `boot/repl-options.ts` (medium risk) 🔥

This is the **core extraction**. The 1,400-line `ReplOptions`
literal (lines ~700–2,080) becomes its own module
`boot/repl-options.ts`, with a factory
`createReplOptions(ctx: BootContext, deps: ReplDeps): ReplOptions`.
The factory takes the assembled `BootContext` plus a small typed
`ReplDeps` interface (agent, container, brain, multiAgentHost,
mailbox, worktree, etc.) and returns the same `ReplOptions` object
that `main()` currently constructs inline.

After this PR, `main()` shrinks from ~2,400 lines to ~400 lines and
reads as a sequence of `await assembleXxx();` calls. The slash-command
callbacks stay where they are (in `repl-options.ts`) but are no longer
nested inside `main()`. Adding a new slash-command callback becomes
"edit `repl-options.ts`", not "edit `cli-main.ts`".

Risk: medium because this is the biggest single extraction and the
callbacks share closure state (e.g. `autonomyMode` /
`autonomyModeRef.current`). The factory must receive all shared state
as parameters; no closure captures.

### PR 5 — `boot/eternal-engine-wiring.ts` (low risk)

Extract the `eternalEngine` / `parallelEngine` lazy-instantiation
and `onEternalStart` / `onEternalStop` callbacks (lines ~1,990–2,080)
into `boot/eternal-engine-wiring.ts`. These are already
near-self-contained; the extraction is mechanical. After this PR,
`repl-options.ts` shrinks by ~200 lines.

### PR 6 — `boot/dispatch.ts` (low risk)

Extract the final TUI-vs-REPL-vs-WebUI dispatch (the `if (mode ===
'tui') { ... } else if (mode === 'webui') { ... } else { await
runRepl(...) }` block at the tail of `main()`) into
`boot/dispatch.ts`. Takes a `DispatchContext` and a `DispatchOpts`
and returns the chosen host. The `main()` function ends with a single
`await dispatch(ctx, opts)` call.

### PR 7 — Final pass (low risk)

`cli-main.ts` should be < 250 lines after PRs 1–6: just argv
parsing, the `boot(argv)` call, and the `dispatch(ctx, opts)` call.
The final pass:

- Collapses the per-phase `let { ... } = ctx` destructuring into
  direct field access where possible.
- Updates the import block in `cli-main.ts` to re-export the public
  types (`BootContext`, `ReplDeps`, `DispatchOpts`) for backward
  compatibility — `index.ts` may still import from `./cli-main.js`
  in the short term.
- Adds a doc comment to `cli-main.ts` pointing to the seven
  `boot/*.ts` modules so contributors know where each phase lives.

## Acceptance criteria

- [ ] Baseline integration test (PR 0) added and committed.
- [ ] Each of PRs 1–6 lands with:
  - The targeted code in a single module under
    `packages/cli/src/boot/`.
  - The original boot behavior preserved (exit codes, side effects,
    and `ReplOptions` shape — verified by the integration test).
  - `pnpm --filter @wrongstack/cli typecheck` clean.
  - `pnpm --filter @wrongstack/cli test` passing (the
    ~17,000-LOC test suite plus the new integration test).
  - A 30-second manual smoke test: launch
    `node packages/cli/dist/index.js --help`, then
    `node packages/cli/dist/index.js tui`, then
    `node packages/cli/dist/index.js repl`, and confirm
    each returns the expected exit code and side-effect.
- [ ] After PR 7: `cli-main.ts` is < 250 lines and contains only
  argv parsing, the `boot()` call, and the `dispatch()` call.
- [ ] The June 5 plan's "1.2: split cli/sdd.ts and cli/index.ts"
  exit criteria (sdd was already split; index.ts → cli-main.ts is
  the modern equivalent) are satisfied: every boot phase lives in
  its own `boot/<name>.ts` file, with `cli-main.ts` as the
  composition root only.

## Out of scope

- `cli/webui-server.ts` (3,407 lines) is the next decomposition
  priority. File a sibling `docs/issues/2026-MM-DD-webui-server-refactor.md`
  using the same template; do not bundle it here.
- `webui/server/index.ts` (3,104 lines) is the same shape but in a
  different package. File `docs/issues/2026-MM-DD-webui-package-server-refactor.md`
  once this issue and the webui-server one are in flight.
- The `slash-commands/fix-classifier.ts: 661` split is a separate
  issue (smaller, more contained; the `sdd.ts` decomposition
  template applies directly).
- The 2026-06-13 TUI refactor is a separate track. It unblocks
  after PR 4 of this issue lands (because new TUI-side effects then
  edit `repl-options.ts`, not `cli-main.ts`).

## Rollback strategy

Each PR is its own commit on its own branch. Revert the PR → revert
the behavior. The integration test in PR 0 is the gate; if a later
PR's boot output differs from the prior commit by more than the test
allows (exit codes, `ReplOptions` snapshot, side-effect order), that
PR is held until parity is restored.

For the bigger PRs (PR 4 in particular) a feature flag is overkill —
the integration test plus the smoke test are the gates. If both
fail-safely (the existing boot output is byte-identical to the
pre-PR baseline), the PR merges.

## Why I'm not implementing this now

The previous tui-app refactor (2026-06-13 morning) made it clear
that a 2,000+ line file in a single session is too big to hold in
mind at once. The same is true of `cli-main.ts` — but unlike
`app.tsx`, this file has no test harness to lean on, so the first
PR *must* be the baseline integration test, and nothing else can
land until that test is in place.

This issue formalizes the **PR-by-PR** approach so a future
session (or human contributor) can take it on with clear scope per
commit. The TUI refactor is the live proof that the pattern works
when the baseline test lands first.

## Tracking

When the issue is opened on GitHub, link the 7 PRs to it in
descending order so the timeline is visible. Use the
`refactor/cli-main-split` label (proposed).

## Related

- June 5 audit, item 1.2 ("Split cli/slash-commands/sdd.ts and
  cli/index.ts") — sdd.ts was already split into `sdd/`. cli/index.ts
  is the legacy name for the file now called `cli-main.ts`.
- 2026-06-13 system audit, finding H-1 ("Four >2,000-line files are
  the gating constraint") — this issue is one of three
  decomposition plans called for by that finding.
- 2026-06-13 tui-app refactor, PR 0 (the characterization-test
  pattern this issue reuses).
- 2026-06-13 system audit, finding H-2 ("`SlashCommandContext` has
  grown into a god-object") — once PR 4 of this issue lands, the
  god-object refactor becomes a `repl-options.ts` exercise, not a
  `cli-main.ts` one.
