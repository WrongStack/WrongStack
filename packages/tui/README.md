# @wrongstack/tui

Ink-based terminal UI for the WrongStack agent. Renders the interactive chat panel, status bar, slash-command picker, model picker, todo list, and permission-confirm dialogs.

The TUI is **lazy-loaded** by [`@wrongstack/cli`](../cli) — it only imports React/Ink when the user passes `--tui`. Plain-REPL users pay no startup cost.

## Install

```bash
pnpm add @wrongstack/tui @wrongstack/core
```

You'd only depend on this directly if you're embedding WrongStack inside another tool and want the TUI surface. Otherwise install [`wrongstack`](../../README.md).

## Quick example

```ts
import { runTui } from '@wrongstack/tui';
import { Agent, DefaultEventBus, SlashCommandRegistry, DefaultAttachmentStore } from '@wrongstack/core';

const exitCode = await runTui({
  agent,                          // configured Agent instance
  slashRegistry,                  // SlashCommandRegistry
  attachments: new DefaultAttachmentStore(),
  events: new DefaultEventBus(),
  model: 'anthropic-test-model',
  banner: true,
  yolo: false,
  appVersion: '0.286.0',
  provider: 'anthropic',
  family: 'anthropic',
  keyTail: '…ABC',
  effectiveMaxContext: 200_000,
  statuslineHiddenItems: [],
  setStatuslineHiddenItems: () => {},
  saveStatuslineHiddenItems: async () => {},
});

process.exit(exitCode);
```

## What you get

```
╭──────────────────────────────────────────────────────────────────────────────╮
│                                                                    v0.287.0  │
│                                                                              │
│          _       ______  ____  _   ______________________   ________ __       │
│         | |     / / __ \/ __ \/ | / / ____/ ___/_  __/   | / ____/ //_/      │
│         | | /| / / /_/ / / / /  |/ / / __ \__ \ / / / /| |/ /   / ,<        │
│         | |/ |/ / _, _/ /_/ / /|  / /_/ /___/ // / / ___ / /___/ /| |       │
│         |__/|__/_/ |_|\____/_/ |_/\____//____//_/ /_/  |_|\____/_/ |_|       │
│                                                                              │
│                     BUILT ON THE WRONG STACK. SHIPPED ANYWAY.                │
│                                                                              │
│  ◆ route   anthropic › anthropic-test-model                                  │
│  ◇ family  anthropic    ◈ key    •••• ABC                                    │
│  ⌁ workspace  /workspace/wrongstack                                          │
│                                                                              │
│  ★ github.com/wrongstack/wrongstack — don't forget to star!                  │
│  ◆ wrongstack.com                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
  user> refactor auth.ts to async/await
 ⠋ thinking (3 tools used · 4.2k tokens · 1.3s)
  > █                                              ⚠ YOLO
 ─────────────────────────────────────────────  ctx 47%
```

The wordmark and route label render in the brand gradient (orange → pink).

- **History pane** — assistant text, tool calls, tool results, errors, turn summaries
- **Streaming text** — partial deltas render live; on abort, partial response is preserved
- **Status bar** — model · provider · context-window % · YOLO chip · spinner
- **Input box** — multi-line buffer with bracketed-paste detection, history (↑/↓), placeholder pills for attachments
- **Pickers** — fuzzy file picker (`@`), slash picker (`/`), model picker (Ctrl+M)
- **Permission dialog** — modal y/n/always/deny for `confirm`-permission tools
- **Todo list** — sidebar reflecting `ctx.todos`
- **Attachments** — images and files dropped into the input become inline content blocks

## Terminal icons and Powerline

The TUI defaults to a portable Unicode icon set, so the segmented status rail,
composer frame, and tool cards work without installing a special font. Two
additional profiles are available through `WRONGSTACK_TUI_ICON_STYLE`:

```powershell
# Rich Powerline + development icons (requires a Nerd Font in the terminal)
$env:WRONGSTACK_TUI_ICON_STYLE = 'nerd'
wstack --tui

# Strict compatibility for basic terminals and CI captures
$env:WRONGSTACK_TUI_ICON_STYLE = 'ascii'
wstack --tui
```

For the `nerd` profile, select a current Nerd Font such as **CaskaydiaCove Nerd
Font** or **MesloLGS Nerd Font** in Windows Terminal, WezTerm, Kitty, or the
terminal host you use. Font selection belongs to the terminal; WrongStack does
not silently install or change system fonts.

## Key bindings

| Key | Effect |
|-----|--------|
| `Enter` | Submit |
| `Shift+Enter` (or `\` newline) | Insert newline |
| `Ctrl+C` (once) | Abort current turn |
| `Ctrl+C` (twice) | Exit |
| `Ctrl+D` (empty buffer) | Exit |
| `↑` / `↓` | History navigation when buffer empty |
| `@` | File picker |
| `/` (at start) | Slash command picker |
| `?` (empty prompt) | Keyboard shortcuts help overlay |
| `F1` | Project switcher (also `/project`) |
| `Ctrl+F` / `F2` | Toggle fleet orchestration monitor |
| `Ctrl+G` / `F3` | Toggle agents panel — left-right split: agent list + live transcript |
| `Ctrl+T` / `F4` | Toggle worktree monitor |
| `F5` | Toggle plan panel |
| `F6` | Toggle todos monitor overlay |
| `F7` | Toggle queue panel |
| `F8` | Toggle process list overlay |
| `F9` | Toggle goal panel |
| `F10` | Toggle live sessions panel |
| `F11` | Toggle coordinator monitor |
| `F12` | Open status line picker |
| `Ctrl+S` | Edit autonomy/settings defaults; also `/settings` |
| `Esc` | Close any picker / dialog / monitor / panel |
| `Ctrl+L` | Clear screen (TUI keeps state — equivalent to scrolling) |

## Options worth knowing

- **`effectiveMaxContext`** — the context-bar denominator. Pass the model-specific value resolved via `ModelsRegistry`, not the family baseline; the 1M Opus variant has a much larger window than the 200k default.
- **`queueStore`** — if set, queued input survives a crash. Without it, queued lines are in-memory only.
- **`onClearHistory`** — invoked from the `/clear` slash command so the TUI can wipe its rendered history entries (keeping just the banner) while `Agent`/memory reset happens elsewhere.

## Architecture

```
runTui                — entry; sets up bracketed paste, signal handlers
  ↓
App (React component) — useReducer-driven state machine
  ↓ dispatches events to ↓
EventBus              — agent.run() emits these, the TUI subscribes
```

State is a single `useReducer` `State` shape with discriminated-union `Action`s. The reducer is exported (`reducer`) and unit-tested.

## React Version

TUI uses React 19 with Ink 7, matching the package dependencies in this workspace.

## License

MIT
