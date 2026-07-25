# /mouse - Full Mouse Mode

## What It Does

The chat history always uses a bounded, in-app-scrolled viewport
(`ScrollableHistory`). Its wheel tracking stays active because native terminal
scrollback cannot reveal virtualized rows. `/mouse on` enables **full mouse
mode**, adding:

- A drag-able scrollbar is shown on the right edge.
- Status-bar chips and confirm-prompt buttons become clickable.

In both modes the wheel scrolls the chat **in-app** one row per report.
`Shift+wheel`, `PgUp`/`PgDn`, and `Ctrl+U`/`Ctrl+D` on an empty composer page
through the in-app history.

`/mouse off` disables scrollbar drag and clickable app chrome; wheel scrolling
of the managed history remains active.

The command is stateless — it emits a toggle intent that the TUI App resolves
against its live state, persists, and confirms. Outside the TUI it is a no-op.

## Usage

| Usage | Effect |
|---|---|
| `/mouse` | Show current mouse-mode status |
| `/mouse on` | Enable full mouse mode |
| `/mouse off` | Disable scrollbar drag and clickable UI |
| `/mouse toggle` | Toggle current state |

The command also accepts `enable`, `true`, `1`, `disable`, `false`, and `0`.

## Enabling at Startup

Mouse mode can also be turned on before the TUI mounts:

- `--mouse` CLI flag (e.g. `wrongstack --tui --mouse`).
- `WRONGSTACK_MOUSE=1` environment variable.
- The persisted `autonomy.mouseMode` setting (set automatically the last time
  you ran `/mouse on`).

Resolution order at launch: `--mouse` → saved setting → `WRONGSTACK_MOUSE`.

## Notes

- The setting persists to the `autonomy` section of the active profile config,
  so a `/mouse on` survives restarts.
- Overlays/pickers use wheel-to-select and click-to-confirm; full mouse mode
  extends pointer interaction to the scrollbar and the rest of the UI.
