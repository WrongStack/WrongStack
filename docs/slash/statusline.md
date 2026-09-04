# /statusline — TUI Status Bar Customizer

## What it does

`/statusline` controls three independent axes of the TUI status bar, live and
without restarting:

1. **Visibility** — which chips are eligible to render.
2. **Line** — which of the four rails a chip renders on (1–4).
3. **Density** — how much of a chip's payload renders (`auto` / `full` /
   `short` / `micro`).

All three persist to `~/.wrongstack/profiles/<name>/statusline.json`.

## The four lines

Lines are grouped by **volatility**, not by topic, so the eye learns where to
look — each rail changes at a predictable rate.

| Line | Name | Changes | Chips |
|---|---|---|---|
| 1 | IDENTITY | never, mid-session | `project` `working_dir` `git` `model` `mode` `prompt_variant` `theme` `sessions` `tools` · right: `version` |
| 2 | VITALS | every token | `state` `context` `tokens` `cost` `cache` `elapsed` `queue` `hint` · right: `index` |
| 3 | SAFETY & WORK | a few times per turn | `yolo` `autonomy` `eternal_stage` `breaker` `token_saving` `processes` `side_effects` `dropped_tools` `goal` `todos` `plan` `tasks` |
| 4 | ASYNC | on its own schedule | `fleet` `fleet_agents` `mailbox` `brain` `debug_stream` `memory_context` `next_steps` `auto_proceed` `enhance` |

Lines 1–2 always render; 3 and 4 open only when they have content, so a
vanilla session keeps a two-line footprint.

`hint` sits on VITALS rather than on a conditional rail on purpose: it appears
and disappears several times within one turn, and parking it on line 3 or 4
would make that whole rail strobe. On line 2 it is simply the first chip
overflow sheds.

## Density: shorten before you drop

Every chip declares up to three renderings, widest to narrowest. When a rail
does not fit the terminal, the fitter repeatedly shortens the chip that gives
back the most columns, and only starts dropping trailing chips once every chip
on that rail is already at its narrowest form.

```
context   ◔ ctx [00o.....] 92k/200k [lossless]  →  [00o...] 46%  →  ◔46%
cache     ✓ 78% r120k w8.4k ~$0.42              →  ✓78% ~$0.42   →  ✓78%
model     anthropic/claude-opus-5[1m]           →  claude-opus-5 →  claude-op…
wdir      ⌁ D:\Codebox\PROJECTS\WrongStack      →  ⌁ …/PROJECTS/WrongStack → ⌁ …/WrongStack
```

Pinning a density (`full` / `short` / `micro`) opts a chip out of that
negotiation: it renders that form at every width, and can only be dropped.
`auto` (the default) leaves it to the fitter.

## Usage

| Usage | Effect |
|---|---|
| `/statusline` | TUI: open the interactive picker; REPL: list the current configuration |
| `/statusline preview` | Print the four lines as they are currently laid out |
| `/statusline <item>` | Toggle a chip on/off |
| `/statusline <item> on\|off` | Enable/disable a chip |
| `/statusline <item> line <1-4>` | Move a chip to another line |
| `/statusline <item> density auto\|full\|short\|micro` | Pin a chip's density |
| `/statusline all on\|off` | Enable/disable every chip |
| `/statusline reset` | Restore default chip visibility (layout untouched) |
| `/statusline layout reset` | Restore default lines and densities (visibility untouched) |

`/statusline` with no arguments and no TUI prints every chip with its state,
line and density. Run `/help statusline` for the full item list.

## The picker

The interactive picker (TUI) opens on a bare `/statusline`, or by clicking the
`plan` / `tasks` / `fleet` chips in the bar.

| Key | Action |
|---|---|
| `↑` `↓` | select (walks the filtered rows) |
| `←` `→` / `Enter` | chip on/off |
| `1`–`4` | move the chip to that line |
| `[` `]` | shift the chip one line up/down (wraps) |
| `d` | cycle density: auto → full → short → micro |
| `a` | turn every chip on the focused line on/off |
| `/` | filter by chip name or description (`Esc` clears) |
| `r` | reset layout (lines + densities) |
| `Esc` | close |

The strip at the top of the picker is **measured, not mocked**: it reads the
rail geometry the status bar published on its last render, so `used/budget`
per line is the real fill at your current terminal width. Chips are annotated
with what the fitter did to them — `‹` shortened, `«` micro, `·` dropped — and
a chip you have moved off its default line is marked `L3*`.

## Defaults

A brand-new `statusline.json` starts with `working_dir`, `theme`, `sessions`,
`tools` and `side_effects` **off**: each is static trivia recoverable from a
slash command, and each costs 10–30 permanent columns on the identity rail.
An existing config file's explicit chip map always wins over this;
`/statusline reset` re-applies the defaults.

## Density mode (minimum / detailed / no-color)

Separate from everything above, the statusline has a **density mode**:

- **`minimum`** (default) — a single rail: state · provider/model · context
  meter (+tokens) · version, plus conditional chips (autonomy when active,
  elapsed when > 0, and a compact work summary).
- **`detailed`** — the four-rail bar described above.
- **`no-color`** — detailed layout without color.

Change it via `/settings` (Statusline field) or the settings picker (Ctrl+S).
The default is `minimum` (`DEFAULT_STATUSLINE_MODE` in
`packages/tui/src/components/settings-picker-model.ts`).

The chip toggles are **mode-independent**: they set whether a chip is eligible
to render in *any* mode. Toggling a detailed-only chip has no visible effect
while in `minimum` mode.

## Persistence

`~/.wrongstack/profiles/<name>/statusline.json`, schema v3:

```json
{
  "version": 3,
  "chips": { "project": true, "theme": false },
  "lines": { "todos": 2 },
  "densities": { "cache": "micro" }
}
```

`lines` and `densities` are sparse — an absent key means "contract default"
and "let the fitter choose". v1 (flat boolean map) and v2 (`chips` + `lines`)
files are migrated in place on first read.

## Code reference

- `packages/core/src/statusline/index.ts` — the framework-free chip contract:
  keys, default lines, default densities, descriptions
- `packages/cli/src/slash-commands/statusline.ts` — the command
- `packages/cli/src/services/statusline-config.ts` — `statusline.json` v3
- `packages/tui/src/components/status-bar-rails.tsx` — chip JSX + density levels
- `packages/tui/src/components/powerline-rail.tsx` — `layoutRail`, the fitter
- `packages/tui/src/components/status-line-registry.tsx` — line partitioning
- `packages/tui/src/components/statusline-picker.tsx` — the picker
- `packages/cli/src/wiring/command-host-state.ts` — host wiring
