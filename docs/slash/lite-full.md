# /lite and /full — TUI Layout Presets

## What they do

One-key chrome presets for the TUI. `/lite` collapses the interface to a minimal layout; `/full` restores the rich layout. Both persist to the config (`autonomy.statuslineMode` + `autonomy.showSidebar`) and take effect immediately — no restart needed.

| Command | Statusline density | Right sidebar |
|---|---|---|
| `/lite` | `minimum` (single clean rail) | hidden (full-width history) |
| `/full` | `detailed` (full multi-line bar) | visible |

## Usage

```
/lite   → ✓ Lite layout: statusline minimum, sidebar off.
/full   → ✓ Full layout: statusline detailed, sidebar on.
```

No arguments. The two commands are exact inverses of each other; toggling between them repeatedly is safe.

## Persistence & live behavior

- Written through the same path as `/settings <chord> <value>`: a `settingsValueSet` dispatch updates the open picker immediately, then `saveSettings` persists to the config target (project or profile, per `configScope`).
- `showSidebar` is the master switch for the right sidebar — when false, `resolveAppSidebarLayout` collapses the sidebar width to 0 before width computation, so chat history takes the full terminal width. Routed sidebar twins and the swarm mission card are suppressed too.
- The sidebar returns automatically on wide overlays (pickers, confirmations) as before; `showSidebar: false` only governs the idle right rail.

## Related surfaces

- `/settings statusline minimum|detailed` — density alone (field 34).
- `/settings sidebar on|off` — the sidebar master switch alone (field 61).
- `/statusline` — per-chip visibility, independent of density mode.

## Code reference

- `packages/tui/src/hooks/use-tui-slash-commands.ts` — command registration (`applyLayoutPreset`)
- `packages/tui/src/app-ui-state.ts` — `resolveShowSidebarVisibility` / `effectiveShowSidebar` dual-source read and the width gate in `resolveSidebarLayout`
- `packages/cli/src/boot/tui-settings-adapter.ts` — `showSidebar` read/write (`autonomy.showSidebar`)
