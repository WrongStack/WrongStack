# /statusline — TUI Status Bar Customizer

## What it does

`/statusline` toggles which items appear in the TUI status bar without restarting. Items are stored in `statuslineHiddenItems` in `SlashCommandContext` and read on TUI mount.

## Usage

| Usage | Effect |
|---|---|
| `/statusline` | TUI: open the interactive statusline picker; REPL: show current configuration |
| `/statusline todos on\|off` | Toggle todos item |
| `/statusline plan on\|off` | Toggle plan item |
| `/statusline fleet on\|off` | Toggle fleet item |
| `/statusline git on\|off` | Toggle git branch + status item |
| `/statusline elapsed on\|off` | Toggle elapsed time item |
| `/statusline context on\|off` | Toggle context window % item |
| `/statusline sage on\|off` | Toggle total and provider-context SAGE memory counts |
| `/statusline cost on\|off` | Toggle estimated cost item |
| `/statusline all on` | Show all items |
| `/statusline all off` | Hide all items |

## Available items

| Item | What it shows |
|---|---|
| `todos` | Current todo count (in_progress / pending / completed) |
| `plan` | Active plan item count |
| `fleet` | Subagent count: 0 pending, 0 done |
| `git` | Branch name + dirty/clean indicator |
| `elapsed` | Session elapsed time (HH:MM:SS) |
| `context` | Context window usage percentage |
| `sage` | All-status SAGE memory record total and memories active in the latest provider request |
| `cost` | Estimated session cost |

## Density mode (minimum / detailed / no-color)

The statusline has a separate **density mode**, independent of the per-chip toggles above:

- **`minimum`** (default) — a single clean rail: state · provider/model · context meter (+tokens) · version, plus conditional chips that appear only when relevant (autonomy when active, fleet working time when > 0, and a compact work summary). RAM/heap/CPU, git, tools, sessions, and the background-service detail lines are hidden.
- **`detailed`** — the full multi-line bar (runtime · session context · active work · background services), including RAM/heap, git, tools, sessions, and the memory/index detail line.
- **`no-color`** — detailed layout without color.

Change it via `/settings` (Statusline field) or the settings picker (Ctrl+S). The default is `minimum` (`DEFAULT_STATUSLINE_MODE` in `packages/tui/src/components/settings-picker-model.ts`).

The `/statusline` chip toggles above are **mode-independent**: they set whether a chip is eligible to render in *any* mode. Toggling a detailed-only chip (e.g. `git`, `sessions`, `tools`, `memory_context`) has no visible effect while in `minimum` mode — switch to `detailed` to see it.

## Persistence

Config is saved to `~/.wrongstack/profiles/<name>/statusline.json` via the `statuslineConfig` callbacks in `SlashCommandContext`.

## Code reference

- `packages/cli/src/slash-commands/statusline.ts`
- `packages/tui/src/components/status-bar.tsx` — TUI status bar rendering
- `packages/cli/src/wiring/command-host-state.ts` — `statuslineConfig` and `statuslineHiddenItems` wiring
