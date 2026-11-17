# @wrongstack/tui

Ink-based terminal UI for the WrongStack agent. Renders the interactive chat panel, status bar, slash-command picker, model picker, todo list, and permission-confirm dialogs.

The TUI is **lazy-loaded** by [`@wrongstack/cli`](../cli) — it only imports React/Ink when the user passes `--tui`. Plain-REPL users pay no startup cost.

## Install

This package is part of the WrongStack monorepo and is not published to npm:
npm publishing was retired after 1.1.11, and the versions already on npm are
frozen. Inside the workspace, depend on it directly:

```json
"@wrongstack/tui": "workspace:*",
"@wrongstack/core": "workspace:*"
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
  appVersion: '0.287.0',
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
- **Tool-result density** — each committed tool card has copy / less / more controls;
  choose the global `minimal`, `normal`, or bounded `full` default under
  `/settings tool-result-view <mode>`
- **Streaming text** — partial deltas render live; on abort, partial response is preserved
- **Status bar** — model · provider · context-window % · YOLO chip · spinner
- **Input box** — multi-line buffer with bracketed-paste detection, history (↑/↓), placeholder pills for attachments
- **Pickers** — fuzzy file picker (`@`), slash picker (`/`), model picker (Ctrl+M)
- **Permission dialog** — modal y/n/always/deny for `confirm`-permission tools
- **Todo list** — sidebar reflecting `ctx.todos`
- **Attachments** — images and files dropped into the input become inline content blocks

## Terminal icons and Powerline

The status bar, the input box header and the tool rows can draw Nerd Font
icons and Powerline separators. Those are private-use code points: in a
terminal whose font lacks them they render as empty boxes. The `icons` setting
chooses the set:

| Value | Draws |
|-------|-------|
| `nerd` | Nerd Font icons and Powerline arrows. Needs a Nerd Font in the terminal. |
| `ascii` | The same layout, with each icon replaced by a character every monospace font has (`◖ ▶ ◗` for the Powerline arrows, `◑`, `=`, `@`, `$` … for the icons), each at the icon's cell width, so nothing shifts. The `❯` prompt and box drawing are unchanged. |
| `auto` (default) | `nerd` only where it is known to render, otherwise `ascii`. |

Set it with, from highest precedence:

```powershell
wstack --tui --icons ascii          # flag
$env:WSTACK_ICONS = 'nerd'          # environment
# config.json: { "icons": "nerd" }  # config (profile or global)
```

`auto` picks `nerd` when `NERD_FONT=1` is set, or in WezTerm, kitty and
Ghostty (they ship the Nerd Font symbols), or in Alacritty / Windows Terminal
when their own config file sets a Nerd Font for the profile in use
(`alacritty.toml` `family`, Windows Terminal `font.face`). Everything else gets
`ascii`: an unknown terminal, tmux or screen (the outer terminal is unknown),
SSH into Alacritty or Windows Terminal (their config is on the other machine),
and browser-hosted terminals (which get the width-safe `browser` profile).
`NERD_FONT=0` forces `ascii` under `auto`. Having a Nerd Font installed is not
enough on its own: the terminal has to use it, so set `icons` to `nerd` if
your terminal does and is not detected.

`--ascii` is a different, stronger switch: it rewrites all output, including
box drawing, the prompt and spinners, to 7-bit ASCII. The legacy
`WRONGSTACK_TUI_ICON_STYLE` (`unicode|nerd|ascii|browser`) still works and
sits between `WSTACK_ICONS` and the config value.

For `nerd`, select a current Nerd Font such as **CaskaydiaCove Nerd Font** or
**MesloLGS Nerd Font** in your terminal. Font selection belongs to the
terminal; WrongStack does not silently install or change system fonts.

## Key bindings

| Key | Effect |
|-----|--------|
| `Enter` | Submit |
| `Shift+Enter` (or `\` newline) | Insert newline |
| `Ctrl+C` (once) | Abort current turn |
| `Ctrl+C` (twice) | Exit |
| `Ctrl+D` (empty buffer) | Exit |
| `↑` / `↓` | History navigation when buffer empty |
| `PgUp` / `PgDn` | Scroll bounded chat history |
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
