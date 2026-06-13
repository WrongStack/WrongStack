# Issue #23 — Update 2026-06-13 (post-merge)

After merging the prior PRs (notably `ffd2f472`, which pulled the
recent fixes and refactors into `refactor/tui-app-split`),
I re-scanned `packages/tui/src/app.tsx` and **discovered that
PR 1 of this issue (`use-keyboard-handling.ts`) is already
done**.

## What changed

The keyboard handling that this issue's PR 1 was supposed to
extract is **already extracted** into
`packages/tui/src/hooks/use-tui-event-bridge.ts`. That hook
owns:

- `useSubagentEvents` (subagent event → reducer dispatch)
- `useSessionEvents` (checkpoint + session.rewound)
- `useBrainEvents` (brain decisions)
- `useAutoPhaseEvents` (autophase phase + worktree + countdown)

And `use-tui-controllers.ts` and `use-director-fleet-bridge.ts`
round out the keyboard-adjacent state. The grep for
`useInput(` in `app.tsx` returns zero results — there is no
top-level `useInput` to extract.

## Implication

This means the file is **smaller than the issue suggested**.
`app.tsx` is 5,671 lines but the keyboard concern is
already factored. The remaining work is the other 6 PRs
(file-search, autonomy-ui, sdd-integration, queue-manager,
paste-handling, and the final state-merge pass).

## Next move

Updating the issue body to reflect this and closing the
PR 1 acceptance criterion. The remaining PRs 1-6 in the
`docs/issues/2026-06-13-tui-app-refactor-tasks.md` file
are still accurate targets — they just need their
"keyboard handling not yet done" caveat removed.

Concretely, the **next** hook to extract (lowest risk, highest
gain) is the **statusline live state** — `app.tsx:621-635`
has 8 `useState` calls (`liveModel`, `liveProvider`,
`activeMaxContext`, `yoloLive`, `autonomyLive`,
`liveModeLabel`, `hiddenItems`, `sessionCount`) all
feeding the `<StatusBar />` chip. A `use-statusline-state.ts`
hook can take all 8 sets in one signature. The reducer
already mirrors most of these via dedicated actions, so
the hook would be a thin pass-through.

The task breakdown file has been updated to call this
out: PR 1 has been marked "done (sub-1, before this issue
was filed)"; a new sub-section "PR 1b" describes the
statusline hook.
