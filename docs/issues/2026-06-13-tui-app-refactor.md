# Split `packages/tui/src/app.tsx` (5,671 lines) into focused hooks

**Filed:** 2026-06-13
**Status:** Open
**Priority:** Medium (long-running, blocked on testing harness)
**Effort estimate:** 5–7 days, sequenced into 8 PRs
**Risk:** High — the file has zero integration test coverage today

## Problem

`packages/tui/src/app.tsx` is 5,671 lines (242 KB). The June 5 refactor
plan (1.1) calls for splitting it into 7 custom hooks under
`packages/tui/src/hooks/`. Three have already been extracted:

- `useDirectorFleetBridge` ✅
- `useTuiControllers` ✅
- `useTuiEventBridge` ✅

That leaves the bulk of the file — keyboard handling, paste handling,
queue management, file search, autonomy UI, and SDD integration — still
in `app.tsx` as inline effects, callbacks, and refs. With the file this
large, every new feature has to be threaded through `App`'s render path
and most refactors require touching the same dozen `useState` slots.

## Why this matters

1. **No integration tests cover the `App` component.** Only
   `app-reducer.ts` (1,502 lines, 47 unit tests) and individual
   sub-components have tests. Extracting hooks without an integration
   harness means any refactor is flying blind.
2. **Single-file cognitive load.** New contributors can't hold the
   whole `App` render in their head, so they add new state to whichever
   `useState` is closest, growing the file further.
3. **Phase 4 work (Director, multi-agent coordinator splits) will
   cascade into `app.tsx`.** A 6k-line component is a hostile neighbor
   for the coordinator refactor — every state move in `Director`
   requires changes in 5+ places in `App` to keep the UI in sync.

## Proposed approach (sequenced, one PR per step)

### PR 0 — Baseline integration test (must come first)

Add a minimal `ink-testing-library` (or `ink` snapshot harness) test
that:

- Mounts `<App />` with a stub Agent that does nothing.
- Asserts the initial render contains the status bar and empty
  history.
- Sends a synthetic keystroke and asserts a side-effect on the stub
  Agent.

This is the safety net for everything that follows. **All later PRs
must keep this test green and re-run it manually after every hook
extraction.** No test → no extraction.

The June 5 plan didn't include this step; it's the lesson from
the September 2025 audit (H14): "Big-file refactors need
characterization tests first, not after."

### PR 1 — `use-keyboard-handling.ts` (low risk)

Extract the global keypress listener (~150 lines including the
`keyHintContext` derivation). Returns `{ keyHintContext, ... }`.
`App`'s render body shrinks by ~5%; no behavior change.

### PR 2 — `use-paste-handling.ts` (low risk)

Extract `feedPaste`/`paste-accumulator` integration. ~120 lines.
Same shape: a hook that owns the `bracketedPaste` state machine and
exposes the resolved paste string.

### PR 3 — `use-queue-manager.ts` (low risk)

The QueuePanel state and dispatch wiring. ~250 lines. Returns the
`queueOpen`, `queueItems`, and `setQueueOpen`/`addQueue` callbacks
that `App` currently threads through.

### PR 4 — `use-file-search.ts` (medium risk)

The `<FilePicker />` open/close + the `searchFiles` debouncer.
~400 lines. Touches a few `useState` and a `useEffect` that watches
input text. The biggest of the small extractions.

### PR 5 — `use-autonomy-ui.ts` (medium risk)

The autonomy picker state, `AUTONOMY_OPTIONS` lookup, and the
brain-decision-prompt wiring. ~350 lines. Co-extract the
`BrainDecisionPrompt` and `<AutonomyPicker />` props interface so
the hook signature is clean.

### PR 6 — `use-sdd-integration.ts` (medium risk)

The SDD (spec-driven dev) mode — `loadGoal`, `resolveWstackPaths`,
spec detection, project context rendering. ~600 lines. The longest
of the extractions. Likely a 2-commit PR.

### PR 7 — Final pass (medium risk)

`App.tsx` should be < 500 lines after PRs 1–6. The final pass
collapses the remaining top-level `useState` slots into a single
discriminated union (or moves the residual ones into
`use-sdd-integration`/`use-queue-manager`). Update `app-state.ts` and
`app-reducer.ts` to match.

## Acceptance criteria

- [ ] Baseline integration test (PR 0) added and committed.
- [ ] Each of PRs 1–6 lands with:
  - The targeted state/effect in a single hook in
    `packages/tui/src/hooks/`.
  - The original behavior preserved (visually + by integration test).
  - `pnpm --filter @wrongstack/tui typecheck` clean.
  - `pnpm --filter @wrongstack/tui test` passing (the 509-test
    suite plus the new integration test).
  - A 30-second manual smoke test: launch `node dist/index.js tui`,
    type a prompt, hit Ctrl-C, confirm the prompt reaches the agent
    and the response renders.
- [ ] After PR 7: `app.tsx` is < 500 lines and contains no inline
  `useState` / `useEffect` / `useCallback` definitions longer than
  ~10 lines.
- [ ] The June 5 plan's "1.1: split app.tsx" exit criteria are
  satisfied: `app.tsx < 500L with extracted hooks in
  tui/src/hooks/`.

## Out of scope

- `app-reducer.ts` (1,502 lines) is already 47-tested; leave for a
  separate effort.
- `app-state.ts` (869 lines) is type-only; no split needed.
- The Director / multi-agent coordinator refactor (Phase 4) is a
  separate track. Once this issue closes, those refactors will
  become much cheaper.

## Rollback strategy

Each PR is its own commit on its own branch. Revert the PR → revert
the behavior. The integration test in PR 0 is the gate; if a later
PR's behavior differs from the prior commit by more than the test
allows, that PR is held until parity is restored.

## Why I'm not implementing this now

The previous session (2026-06-13 morning) tried a 7-hook extraction
in one pass and the AI explicitly called it out as too risky: no
baseline integration test means the refactor can't be verified
without manual TUI smoke tests on every commit, and a 5,671-line
component in a single session is too big to hold in mind at once.

This issue formalizes the **PR-by-PR** approach so a future session
(or human contributor) can take it on with clear scope per commit.

## Tracking

When the issue is opened on GitHub, link the 8 PRs to it in
descending order so the timeline is visible. Use the
`refactor/tui-app-split` label (proposed).

## Related

- June 5 audit, item 1.1 ("Split tui/src/app.tsx")
- June 7 quality review, item L-3 ("app.tsx still over 5k lines")
- 2026-06-13 system audit, finding #11 ("tui/src/run-tui.ts:
  silenceTerminal captures origConsoleLog at module load")
