# TUI Keyboard Reference

> All key bindings for the WrongStack terminal UI. Key handling is layered:
> overlays and pickers (highest priority) claim their keys first; unclaimed
> keys fall through to the chat input (character movement, editing, history).

---

## Table of Contents

1. [Status-aware keys](#1-status-aware-keys)
2. [Pickers (modal overlays)](#2-pickers-modal-overlays)
3. [Monitor overlays](#3-monitor-overlays)
4. [Inline input editing](#4-inline-input-editing)
5. [Mouse interactions](#5-mouse-interactions)
6. [Enter/Tab special behavior](#6-entertab-special-behavior)
7. [Component-internal keys](#7-component-internal-keys)

---

## 1. Status-aware keys

These keys behave differently depending on whether an LLM request is running.

### Esc — interrupt

| Agent status | Effect |
|---|---|
| `idle` | Falls through to normal text handling (inserts nothing — Esc is a terminal control char) |
| `running` / `aborting` | When `confirmExit` is **on** → shows confirmation dialog. When `confirmExit` is **off** → interrupts immediately, aborts subagents, drops queue, shows "↯ Interrupted" banner |
| `running` + `confirmExit` dialog shown | **y** or **Enter** = confirm interrupt; **n** or **Esc** = cancel, let agent continue |

### `?` — help overlay

Opens the help overlay when **all** of these are true:
- Input buffer is empty
- No picker or overlay is open
- No Ctrl/Meta modifier held

### Enter — submit

| Condition | Effect |
|---|---|
| Idle, Shift held | Insert literal newline at cursor |
| Idle, no Shift | Submit message to agent |
| Running | Queue message (delivered when agent goes idle) |
| Auto-submit countdown active | Cancels countdown, submits immediately |

---

## 2. Pickers (modal overlays)

Each picker **blocks all other input** while open. Keys that don't match are ignored.

### Model picker (`/model`, click model chip)

Two-step: Step 1 = select provider, Step 2 = select model.

| Key | Step 1 (provider) | Step 2 (model) |
|---|---|---|
| ↑ | Move selection up | Move selection up |
| ↓ | Move selection down | Move selection down |
| Mouse wheel | Move selection | Move selection |
| Enter | Pick provider → show models | Switch to model, close picker |
| Esc | Close picker | Back to provider list |
| Backspace | — | Delete last filter char; if filter empty → back to providers |
| Any printable char | — | Append to search filter |

### Autonomy picker (click autonomy chip)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Apply selected autonomy mode, close picker |
| Esc | Close picker (no change) |

### Resume picker (`/resume`, `/sessions`, `/load`)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Resume selected session, close picker |
| Esc | Close picker |

### Settings picker (Ctrl+S, `/settings`)

| Key | Effect |
|---|---|
| ↑ | Move field selection up |
| ↓ | Move field selection down |
| ← | Cycle field value backward / toggle boolean off |
| → | Cycle field value forward / toggle boolean on |
| Mouse wheel | Move field selection |
| Enter | Close settings (changes auto-saved) |
| Esc, Ctrl+S | Close settings |

### Statusline picker (`/statusline`, `/sl`, click chip)

| Key | Effect |
|---|---|
| ↑ | Move focus to previous chip |
| ↓ | Move focus to next chip |
| ← | Toggle focused chip on/off |
| → | Toggle focused chip on/off |
| Mouse wheel | Move focus |
| Esc | Close picker |

### Project picker (F1, `/project`)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Select project → exit with code 42 (host re-launches in new project); select "new session" → same exit-42; select "prev sessions" → opens `/resume` |
| Esc | If filter is non-empty → clear filter; if filter is empty → close picker |
| Printable char | Append to search filter |
| Backspace | Remove last filter char |

### Sessions panel (F10)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter (first press) | Select session: if same project → show confirmation; if different project → exit with code 42 |
| Enter (second press) | Confirm and resume selected session |
| Esc | If resume confirmation shown → clear confirmation; otherwise → close panel |

### Slash picker (type `/` in input)

Opens automatically when `/` is typed at the beginning of the input buffer.

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Run selected command (with arguments if any) |
| Tab | Autocomplete: fill input with selected command name, close picker |
| Esc | Close picker (return to editing) |

### File/attachment picker (type `@` or `#` in input)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Mouse wheel | Move selection |
| Enter | Accept selected match |
| Esc | Close picker (return to editing) |

### Checkpoint timeline (`/rewind`)

Owns its own `useInput`. Rendered as a full-screen overlay.

| Key | Effect |
|---|---|
| ↑ | Select previous checkpoint |
| ↓ | Select next checkpoint |
| Enter | Rewind to selected checkpoint |
| Esc | Cancel, close timeline |

### F-key panel picker (`/f`)

| Key | Effect |
|---|---|
| ↑ | Move selection up |
| ↓ | Move selection down |
| Enter | Execute selected action (toggle monitor), close picker |
| Esc | Close picker |

---

## 3. Monitor overlays

Each overlay can be open simultaneously with the chat input. The Input stays mounted alongside them, so they don't own the keyboard — the central `handleKey` routes keys first.

### Overlay toggle keys

All toggles close any other overlay before opening. Prefer slash commands or F-key aliases over Ctrl chords when a terminal host intercepts a shortcut.

> F-key and Ctrl-alias dispatch is **table-driven** via `fKeyEntryFor()` in `f-key-panels.ts`. Adding a new F-key panel requires one entry in `F_KEY_PANEL_ENTRIES` (with optional `ctrlAlias` and `hostAction` fields) instead of editing a hand-maintained `if` cascade.

| Key | Overlay | Preferred fallback | Terminal conflict notes |
|---|---|---|---|
| F1 | Project switcher | `/project` | F1 is commonly reserved for terminal/app help |
| Ctrl+F, F2 | Fleet orchestration monitor | F2 or `/fleet` | Ctrl+F is commonly intercepted for Find/Search |
| Ctrl+G, F3 | Agents live monitor | F3 or `/agents` | Ctrl+G is usually safe, but F3 is the safer terminal alias |
| Ctrl+T, F4 | Worktree monitor | F4 or `/worktree` | Ctrl+T may be used by shells/terminal hosts |
| F5 | Plan panel | `/plan` | F5 may be reserved for refresh/run/debug by host apps |
| F6 | Todos monitor | `/todos` | Usually low risk |
| F7 | Queue panel | `/queue` | Usually low risk |
| F8 | Process list ⚠️ modal | `/ps` | Blocks all input while open (destructive shortcuts) |
| F9 | Goal panel | `/goal` | Usually low risk |
| F10 | Sessions panel | `/resume` | F10 may activate terminal/app menus |
| F11 | Coordinator monitor | `/coordinator` | F11 is commonly reserved for fullscreen |
| F12 | Statusline picker | `/statusline` or `/sl` | F12 may be reserved by host tools/devtools |
| Ctrl+B | SDD board overlay | — | Multi-agent SDD board (chord-only, no F-key alias) |
| Ctrl+S | Settings picker | `/settings` | Ctrl+S may trigger terminal flow-control or host Save |
| Ctrl+P | PhaseMonitor | `/goal status` | Ctrl+P may be used for history/command-palette navigation |

### Esc close fallback

When Esc is pressed and no earlier handler consumed it (no busy-interrupt, no picker, no help overlay), a data-driven table (`esc-close-panels.ts`) looks up the first open panel and dispatches its close action. The table is checked in priority order — fullscreen monitors first (F3 agents, F2 fleet), then non-modal overlays (F6 todos, F7 queue, F8 processList, F9 goal, context, F5 plan, cron, SDD board, coordinator, sessions), then modal pickers (settings, project, help) as a safety net.

Panels **excluded** from the table own their own Esc handler via a child `useInput` hook — dispatching the toggle from the parent too would double-fire on a single keypress and immediately re-open the panel:

| Panel | Why excluded | Own Esc handler |
|---|---|---|
| WorktreeMonitor (F4) | Double-toggle risk | `isWorktreeMonitorCloseKey` in WorktreeMonitor.tsx |
| PhaseMonitor (Ctrl+P) | Double-toggle risk | Own `useInput` in PhaseMonitor.tsx |
| KanbanPanel (`/kanban`) | Double-toggle risk | `key.escape \|\| 'q' → onClose` in KanbanPanel.tsx |
| GoalKanbanPanel | Double-toggle risk | `key.escape \|\| 'q' → onClose` in GoalKanbanPanel.tsx |

Adding a new panel to the Esc-close set requires one entry in `ESC_CLOSE_PANELS` — the table is the single source of truth, replacing a former 76-line hand-maintained `if` cascade.

### Agents monitor (F3) internal keys

| Key | Effect |
|---|---|
| ↑ | Select previous agent in list |
| ↓ | Select next agent in list |

### Process list (F8) internal keys

> **⚠️ Modal panel.** Unlike other F-key overlays (F2/F3/F4/F6/F7/F9) which keep the chat input live, the ProcessList **blocks all keyboard input** while open. This is intentional — the panel has destructive shortcuts (kill, force-kill, kill-all) that must not be triggered by chat typing. The panel footer shows a `⏸ INPUT PAUSED` badge. Press **F8** or **Esc** to close and resume typing.

| Key | Effect |
|---|---|
| ↑ | Select previous process |
| ↓ | Select next process |
| PgUp | Move selection up one page |
| PgDn | Move selection down one page |
| Home, Ctrl+A, **g** | Jump to first process |
| End, Ctrl+E, **G** | Jump to last process |
| Enter (return) | Send SIGTERM to selected process (confirms first) |
| Delete | Send SIGKILL to selected process (confirms first) |
| **a** | Kill all processes — SIGTERM (confirms first) |
| **A** | Kill all processes — SIGKILL (confirms first) |
| **r** | Force-reset circuit breaker |
| **y**/Enter (in confirm) | Confirm kill action |
| **n**/Esc (in confirm) | Cancel kill action |

### Coordinator panel (F11) internal keys

| Key | Effect |
|---|---|
| **q**, **Q**, Esc | Close panel |

### Goal panel (F9) internal keys

| Key | Effect |
|---|---|
| **c**, **C** | Start coordinator with current goal |
| **S** | Stop coordinator |

### Plan panel (F5) internal keys

| Key | Effect |
|---|---|
| **s**, **S** | Toggle plan scope (session ↔ project) |

### Worktree monitor (F4) internal keys

| Key | Effect |
|---|---|
| Ctrl+W | Close monitor |

---

## 4. Inline input editing

These keys are active only when the input buffer is focused (no picker or overlay is open).

### Cursor movement

| Key | Effect | Terminal conflict notes |
|---|---|---|
| ← | Move cursor left by one character | Standard terminal input |
| → | Move cursor right by one character | Standard terminal input |
| Ctrl+← | Move cursor to previous word start | Terminal-dependent; host pane/tab navigation may intercept it |
| Ctrl+→ | Move cursor to next word end | Terminal-dependent; host pane/tab navigation may intercept it |
| Home | Move cursor to start of line | Standard terminal input |
| End | Move cursor to end of line | Standard terminal input |
| Ctrl+A | Move cursor to start of line | Readline-compatible fallback when Home is unavailable |
| Ctrl+E | Move cursor to end of line | Readline-compatible fallback when End is unavailable |

### Multi-line navigation (when buffer contains newlines)

| Key | Effect |
|---|---|
| ↑ | Move cursor up one visual row |
| ↓ | Move cursor down one visual row |
| PageUp | Move cursor up half a screenful |
| PageDown | Move cursor down half a screenful |

On single-line buffers, ↑/↓ fall through to history navigation (see below).

### Text editing

| Key | Effect | Terminal conflict notes |
|---|---|---|
| Backspace | Delete character before cursor (token-aware: deletes whole chips like `[pasted ...]`) | Standard terminal input |
| Ctrl+Backspace, Alt+Backspace | Delete previous word (chip-aware) | Terminal-dependent; Alt may arrive as Esc-prefixed input |
| Delete | Delete character at cursor (token-aware) | Standard terminal input |
| Ctrl+Delete | Delete next word (chip-aware) | Terminal-dependent; host pane/tab navigation may intercept it |
| Ctrl+U | Delete entire line (clear buffer) | Readline-compatible |
| Ctrl+K | Delete from cursor to end of line | Readline-compatible |
| Ctrl+D | Delete character at cursor (forward delete) | Shell EOF in normal terminals; safe inside TUI raw input |
| Ctrl+V | Paste text from system clipboard | May be intercepted by terminal/IDE paste bindings |
| Alt+V | Paste image from clipboard → inserts `[image #N]` chip | Terminal-dependent; use a slash command fallback if your terminal reserves Alt chords |
| Any printable char | Insert at cursor position | Standard terminal input |

### History navigation

Single-line buffers only (multi-line uses ↑/↓ for row movement).

| Key | Effect |
|---|---|
| ↑ (single line) | Scroll input history back (older submission) |
| ↓ (single line) | Scroll input history forward (newer submission) |

History navigation is skipped when any overlay is open.

### Clipboard

| Key | Effect |
|---|---|
| Ctrl+V | Paste text from system clipboard (reads clipboard via `clipboardy` or fallback) |
| Alt+V | Read image from clipboard, save to sessions dir, insert `[image #N]` chip |

### Large paste handling

Any input chunk >200 characters (or containing newlines) is collapsed to an inline `[pasted #N, L lines]` chip instead of leaking into the row.

---

## 5. Mouse interactions

Mouse tracking must be enabled (mouse mode). See `mouse.ts` for protocol details.

### scrollbar

| Action | Effect |
|---|---|
| Click/drag on right-edge scrollbar track | Jump chat viewport to that scroll position |

### Status bar chips

All clicks require `press` (not release/drag) with the left button.

| Region | Click effect |
|---|---|
| Line 1 — model chip | Open model picker (provider → model two-step) |
| Line 2 — autonomy chip | Open autonomy picker |
| Line 3 — todos chip | Toggle todos monitor overlay |
| Line 3 — todos chip area | Open statusline picker, focus [todos] |
| Line 3 — plan chip area | Open statusline picker, focus [plan] |
| Line 3 — tasks chip area | Open statusline picker, focus [tasks] |
| Line 4 — fleet chip area | Open statusline picker, focus [fleet] |
| Hidden chips are not clickable | — |

### Wheel / page scroll

| Action | Effect |
|---|---|
| Mouse wheel (no overlay) | Scroll chat by 3 rows |
| Shift+wheel (no overlay) | Scroll chat by one page |
| PageUp (no overlay) | Scroll chat up one page |
| PageDown (no overlay) | Scroll chat down one page |

All wheel/page scroll is skipped when any overlay is open (overlays own their scroll).

### Mouse modes

| Mode | Sequence | Events captured |
|---|---|---|
| Click-only | `?1000h` + `?1006h` | Press, release, wheel |
| Drag | `?1002h` + `?1006h` | Adds motion-while-button-held |
| Hover | `?1003h` + `?1006h` | Adds free motion (expensive) |

Mouse tracking is enabled per-overlay or globally. Disabled on cleanup via `?1003l ?1002l ?1000l ?1006l`.

---

## 6. Enter/Tab special behavior

### Enter on non-idle agent

If the agent is running when Enter is pressed, the message is **queued** — it is delivered when the agent returns to idle. The queue is flushed on every idle transition.

### Tab with next-steps auto-submit

When the auto-submit countdown is visible (suggested `/next` step counting down):
- **Tab** — grab the suggestion into the input buffer for editing, cancel the countdown
- **Any other key** — cancel countdown (does NOT pre-fill input)

### Enter debounce

Terminals often emit `\r\n` as two separate stdin events. All Enter handlers debounce with a 50ms window: the second event is silently dropped.

---

## 7. Component-internal keys

These components register their own `useInput` hooks in addition to the central router.

### Brain decision prompt

Shown when the Brain arbiter requires a human decision (risky operation).

| Key | Effect |
|---|---|
| **a**–**z**, **0**–**9** | Select option by letter/number |
| **d**, Esc | Deny the operation |
| Enter, **y** (in EscConfirm) | Confirm interrupt |

### Enhance panel (refine/edit)

| Key | Effect |
|---|---|
| Enter | Accept refined version |
| Esc | Reject, keep original |
| **e** | Accept English translation |
| **t** | Open for manual editing |

### ConfirmPrompt (permission dialog)

Shown when an external tool action requires human approval.

| Key | Effect |
|---|---|
| **y** | Yes — allow the action |
| **n** | No — deny the action |
| **a** | Always allow (never ask again for this tool) |
| **d** | Deny (same as n — explicit deny) |

### EscConfirmPrompt (interrupt confirmation)

Shown when Esc is pressed while agent is running AND `confirmExit` is enabled.

| Key | Effect |
|---|---|
| **y**, Enter | Confirm interrupt |
| **n**, Esc | Cancel, let agent keep running |

### Worktree monitor close

| Key | Effect | Terminal conflict notes |
|---|---|---|
| Esc, F4 | Close worktree monitor panel | Preferred terminal-safe close keys |
| Ctrl+W | Close worktree monitor panel | May be intercepted as close-tab/pane or delete-word by terminal hosts |

---

## Key dispatch order

The central `handleKey` function in `app.tsx` checks keys in this **strict priority order**. The first matching condition wins; all others are skipped.

1. Ctrl+C (unconditional — always first, before all modal guards)
2. Modal guards: aborting, confirmQueue, shellCommandWarning, enhanceBusy, enhance, refineFailure, continueConfirm, escConfirm, sendModePicker
3. Help overlay (Esc / `?` / `q` dismiss)
4. Picker dispatch via `usePickerKeys` (model, autonomy, design, resume, settings, project, plugin, mcp, tools, help-panel, brain, shadow, statusline, sessions, slash, fKeyPicker, general picker)
5. **Esc while agent is busy** → interrupt (with optional confirm dialog via `confirmExit`)
6. F-key overlay toggles — table-driven via `fKeyEntryFor()` + Ctrl aliases (Ctrl+F/G/T/B, F1–F12)
7. **Esc** → data-driven close via `escCloseAction()` (see "Esc close fallback" above)
8. ProcessList (F8) modal guard — blocks all remaining keys
9. **`?` on empty prompt** → help overlay
10. **Enter** → submit / queue message
11. **Tab** with auto-submit countdown → grab suggestion
12. **Backspace/Ctrl+Backspace/Ctrl+W** → delete
13. **Delete/Ctrl+Delete** → forward delete
14. **←/→ (plain/Ctrl)** → cursor movement
15. **Home/End** → cursor to start/end
16. **↑/↓** on multi-line buffer → row navigation
17. **↑/↓** on single-line, no overlay → history scroll
18. **Ctrl+V** → paste text
19. **Alt+V** → paste image
20. Any printable char → insert at cursor

Steps 9–20 are blocked when any overlay is open (checked via `overlayOpen` flag).

## `/clear` and session generation

When the user types `/clear`, the TUI performs a three-step cleanup to prevent stale fleet events from re-polluting the cleared conversation:

1. **`terminateAll()`** — kills all running subagents (capped at 1.5s timeout so a wedged director bridge can't hang the clear). Without this, in-flight subagents keep executing and their completion events inject entries into the cleared history.

2. **`sessionGenerationRef++`** — bumps a session generation counter. The provider-response/text-delta/thinking-delta listeners check this counter and discard any output from the pre-clear run. Even if a provider ignores the abort signal and resolves normally, its output is dropped.

3. **`clearHistory` reducer** — resets `entries` to just the banner, clears `fleet: {}`, resets cost/token counters, and bumps `historyGen` to force Ink's `<Static>` to remount.

### Fleet generation gate

Both fleet event bridges (`useSubagentEvents` for EventBus lifecycle, `useDirectorFleetBridge` for Director FleetBus streaming) share a `useFleetGenerationGate` hook. The hook tracks each subagent's spawn generation and discards events from agents spawned before the last `/clear`:

- **`gate.track(id)`** — called when a subagent is first seen (spawn event or initial status scan)
- **`gate.isLive(id)`** — checked before processing any event; returns `false` after `/clear` bumps the generation
- **`gate.forget(id)`** — called when a subagent is removed

This prevents a dying subagent's `task.completed` or `fleetDone` dispatch from injecting entries into the freshly-cleared chat — a race that `terminateAll()` alone can't fully close because subagent termination is asynchronous.

When `sessionGenerationRef` is not provided (no `/clear` support wired), `isLive` always returns `true` — backward-compatible no-op.

## Key event model

Keys are decoded by two parallel mechanisms:

- **Ink's `useInput`** — handles all standard keys (arrows, letters, Ctrl, Esc, Tab, Backspace, Return, Shift). Provides `KeyEvent` booleans.
- **Raw stdin** — catches Home/End (CSI sequences not decoded by Ink 5.x), Backspace as `\x08` (Windows Terminal sends BS, not DEL), Delete, F1–F12 (CSI `~` sequences), mouse SGR reports, and ESC+buffering for Alt+Backspace detection.

The raw handler uses a 10ms ESC buffer: when Esc is received, it waits 10ms for a follow-up byte. If Backspace (`\x7f`/`\x08`) arrives within 10ms, it's emitted as Ctrl+Backspace (delete word). After 10ms with no follow-up, a real Esc press is emitted to Ink.

Both paths converge on `onKey(input, key)` → `handleKey()` in App.
