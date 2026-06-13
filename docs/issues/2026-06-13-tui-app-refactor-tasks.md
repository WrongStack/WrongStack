# tui/src/app.tsx refactor — PR-by-PR task breakdown

**Source issue:** [#23](https://github.com/WrongStack/WrongStack/issues/23)
**Branch:** `refactor/tui-app-split`
**PR 0 merged:** `fe357edb` (baseline integration test)

This file breaks the high-level plan from the issue body
into the **concrete, file:line-anchored** tasks needed to
land each PR. Use it as the entry point for a fresh
session that wants to pick up where this one left off.

The baseline test in `packages/tui/tests/app-mount.test.ts`
must keep passing (in addition to the 509-test tui suite)
throughout every PR.

---

## PR 1 — `use-keyboard-handling.ts` (low risk, ~150 lines)

**Scope:** Extract the global keypress listener that drives
the app's "global shortcuts" (Esc, F1-F12, Ctrl+key
combos). Returns `{ keyHintContext }` for `<KeyHintBar />`.

**Where to start:**

1. `packages/tui/src/app.tsx` — search for `useInput(`
   calls. There are 5+ of them. Most are inside individual
   subcomponents (History, AgentsMonitor, etc.); only the
   **top-level** one inside `App` itself is the candidate.
2. The top-level `useInput` is registered by the
   `useTuiEventBridge` hook (`packages/tui/src/hooks/use-tui-event-bridge.ts`)
   — read that file first to see the existing pattern.
3. The new hook goes in
   `packages/tui/src/hooks/use-keyboard-handling.ts`.

**Touchpoints (verified via grep, 2026-06-13):**
- `app.tsx:825` — comment about `\\x1b[200~` (bracketed
  paste start sentinel) at the top of a keypress
  handler.
- `app.tsx:3067` — comment about
  "is not reliable when multiple useInput hooks are
  active" — the existing pattern is to read the
  app-level flag and bail early.
- `app.tsx:3987-4026` — three comments about
  "each owns its own Esc close via its own useInput"
  and "would fire it twice in one keypress and the
  panel would re-open" — these are exactly the cases
  PR 1's hook must preserve.
- `app.tsx:5190` — comment about
  "Each live panel that needs navigation reads ↑↓
  through its own useInput".

**Acceptance:**

- [ ] Top-level `useInput` lives in
  `use-keyboard-handling.ts`.
- [ ] `app.tsx` calls the hook and passes through
  any flags it needs.
- [ ] `<KeyHintBar />` continues to receive the same
  `keyHintContext` it does today (compare snapshot).
- [ ] Esc closes the same panels it does today
  (History, Settings, Confirm modal, Fleet overlay).
- [ ] Bracketed paste (the `\\x1b[200~` sentinel) is
  handled identically.
- [ ] Baseline test still passes.

**Risk:** Low. The hook only changes where the
`useInput` lives; the side-effects it triggers
(close modal, switch view, etc.) are unchanged.

---

## PR 2 — `use-paste-handling.ts` (low risk, ~120 lines)

**Scope:** Extract `feedPaste`/paste-accumulator
integration. Returns the resolved paste string.

**Where to start:**

1. `packages/tui/src/app.tsx` — search for
   `feedPaste(` and `paste-accumulator`. The feed is
   wired into the `useInput` handler so the hook in
   PR 1 will pass keystrokes to it.
2. `packages/tui/src/paste-accumulator.ts` — the
   underlying state machine; read it first.
3. `packages/tui/src/hooks/use-paste-handling.ts` — the
   new hook.

**Touchpoints:**
- `app.tsx:825` again — the bracketed-paste sentinel
  parsing. PR 1 already touches this; PR 2 should
  either leave it in PR 1's hook or move it here.
  Recommend moving to PR 2 so PR 1 stays focused on
  key-only handling.

**Acceptance:**

- [ ] Pasting `hello\\nworld` into a prompt produces
  the same resolved string in the prompt input as
  today.
- [ ] Pasting within a bracketed-paste session (`ESC[200~`
  start, `ESC[201~` end) is recognized identically.
- [ ] The hook is consumed by `use-keyboard-handling.ts`
  (or sits beside it in `use-paste-handling.ts` and is
  called by the same `useInput` callback).

**Risk:** Low. Paste handling is well-isolated.

---

## PR 3 — `use-queue-manager.ts` (low risk, ~250 lines)

**Scope:** The QueuePanel state and dispatch wiring.
Returns `{ queueOpen, queueItems, setQueueOpen, addQueue }`
(or similar) for `App` to thread through.

**Where to start:**

1. `packages/tui/src/app.tsx` — search for `queue` and
   `QueuePanel`. Find the `useState`/`useEffect` cluster
   that backs the queue.
2. `packages/tui/src/components/QueuePanel.tsx` — the
   presentational component; it likely already accepts
   `queueOpen`/`queueItems` as props.

**Touchpoints:** Most likely around `app.tsx:3000-3100`
(queue state is near the prompt state), and the
`<QueuePanel />` JSX in the render.

**Acceptance:**

- [ ] Queue state lives in the new hook.
- [ ] `<QueuePanel />` still receives the same props.
- [ ] Ctrl+Q (or whichever shortcut opens the queue)
  still toggles the panel.
- [ ] The fleet add-to-queue path still appends.

**Risk:** Low.

---

## PR 4 — `use-file-search.ts` (medium risk, ~400 lines)

**Scope:** The `<FilePicker />` open/close + the
`searchFiles` debouncer.

**Where to start:**

1. `packages/tui/src/app.tsx` — search for
   `FilePicker` and `searchFiles`. The picker is opened
   by `@`-token in the input, and the search is
   debounced against the input text.
2. `packages/tui/src/file-search.ts` — the underlying
   search function.
3. `packages/tui/src/components/FilePicker.tsx` — the
   presentational component.

**Touchpoints:** Likely a `useState` for `pickerOpen` and
a `useEffect` with `setTimeout` for the debounce. Around
`app.tsx:3000-3500` if the search is co-located with the
input.

**Acceptance:**

- [ ] `@` in the input opens the picker.
- [ ] Typing after `@` debounces the search.
- [ ] Selecting a file inserts the path into the input.
- [ ] Esc closes the picker without inserting.

**Risk:** Medium — the debounce timer is a common
source of memory leaks. The hook must clean up the
timer on unmount and on every keystroke.

---

## PR 5 — `use-autonomy-ui.ts` (medium risk, ~350 lines)

**Scope:** The autonomy picker state, `AUTONOMY_OPTIONS`
lookup, and the brain-decision-prompt wiring.

**Where to start:**

1. `packages/tui/src/app.tsx` — search for
   `AUTONOMY_OPTIONS`, `BrainDecisionPrompt`,
   `AutonomyPicker`. The autonomy state is the
   `AutonomyStage` enum.
2. `packages/tui/src/components/AutonomyPicker.tsx` —
   the picker.
3. `packages/tui/src/components/BrainDecisionPrompt.tsx`
   — the brain prompt.

**Touchpoints:** The `AutonomyStage` import and the
state that tracks it. Around `app.tsx:3500-4000`
likely.

**Acceptance:**

- [ ] Autonomy can be changed via the picker and via
  the slash command.
- [ ] The brain-decision-prompt is still shown when
  the brain needs to decide.
- [ ] `AUTONOMY_OPTIONS` is the single source of truth
  for the picker's options.

**Risk:** Medium — autonomy is critical to behavior;
the hook must be wired to the brain's decision API
the same way the current code is.

---

## PR 6 — `use-sdd-integration.ts` (medium risk, ~600 lines)

**Scope:** The SDD (spec-driven dev) mode — `loadGoal`,
`resolveWstackPaths`, spec detection, project context
rendering. The longest of the extractions.

**Where to start:**

1. `packages/tui/src/app.tsx` — search for `loadGoal`,
   `sdd`, `goal`, `sddContext`. The SDD mode is the
   biggest single concern outside of input handling.
2. `packages/tui/src/components/GoalPanel.tsx` — the
   goal panel.
3. `packages/tui/src/components/SessionsPanel.tsx`
   and `ResumePicker.tsx` — likely co-located with
   the session state that SDD drives.

**Touchpoints:** Likely a `useState` for the current
goal and a `useEffect` that calls `loadGoal` /
`resolveWstackPaths` on mount. Around `app.tsx:4000-4500`
likely.

**Acceptance:**

- [ ] Starting a session in SDD mode loads the goal.
- [ ] Switching projects re-loads the goal.
- [ ] `<GoalPanel />` shows the current goal.
- [ ] The slash command `/goal` still works.

**Risk:** Medium. SDD is a separate mode, so the
risk is contained — if it breaks, only SDD sessions
are affected.

---

## PR 7 — Final state-merge pass (medium risk)

After PRs 1-6, `app.tsx` should be < 500 lines. The
final pass collapses the remaining top-level
`useState` slots into a single discriminated union
(or moves the residual ones into the existing
hooks) and updates `app-state.ts` and
`app-reducer.ts` to match.

This PR is essentially "refactor the leftovers."
It cannot be planned in detail until PRs 1-6 are
landed; the shape of the residual state is a
function of how each hook turned out.

Recommend deferring this PR's detailed design
until after PR 6 is merged.

---

## Out of scope for all 7 PRs

- `app-reducer.ts` (1,502 lines) — already 47-tested;
  leave for a separate effort.
- `app-state.ts` (869 lines) — type-only; no split
  needed unless PR 7 reveals duplication.
- Director / multi-agent coordinator refactors
  (Phase 4) — separate track.

## Cross-cutting

The **baseline test** (`packages/tui/tests/app-mount.test.ts`)
must pass after every PR. The new test asserts App
mounts without throwing, and the 60+ stub props it
uses are a known-good "loose interface" — if a new
hook accidentally removes a prop that App needs, the
baseline test will catch it.

A `tests/helpers/app-stubs.ts` is the next thing
to land after this batch: a `createAppStubs()`
factory that returns the 60+ no-op props. Once
that's in, add a second test that types "hello"
and asserts the prompt input shows "hello" — that
test is the true safety net for any future
refactor of the input path.
