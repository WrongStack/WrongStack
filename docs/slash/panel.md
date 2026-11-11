# /panel — Declarative Plugin UI Panels & Status Chips

Inspects and interacts with host-neutral declarative UI panels and status-bar chips contributed by plugins via `api.ui.registerPanel(...)` and `api.ui.registerStatusChip(...)`.

## Subcommands

| Usage | Effect |
|---|---|
| `/panel` | Open `<PluginPanelOverlay>` in the TUI when panels are registered; otherwise list registered panels and status chips |
| `/panel list [--json]` | List registered plugin panels and status chips (or emit a structured JSON catalog with `--json`) |
| `/panel open [panel-id]` | Open the interactive TUI panel overlay focused on `panel-id` |
| `/panel show <panel-id> [--json]` | Render a plugin panel's `PluginViewNode` tree as structured text (or JSON with `--json`) |
| `/panel action <panel-id> <action-id> [--json]` | Invoke a declared panel action and re-render the updated panel |

## Host-neutral `PluginViewNode` rendering

Plugins never import terminal or DOM framework primitives (`ink` or `react`). Instead, `api.ui.registerPanel(...)` returns a validated `PluginViewNode` tree (`text`, `keyValue`, `table`, `badge`, `progress`, `stack`, `code`) bounded to depth 8 and 64 KiB serialized size, with updates coalesced at 4 Hz (`PluginUiRegistry`).

- **TUI:** `<PluginPanelOverlay>` renders panels interactively (`←` / `→` or `Tab` to cycle panels, declared single-key shortcuts to run panel actions, `r` to refresh, `Esc` to close), while status chips appear in the status line.
- **WebUI:** `/panel` opens `<PluginUiModal>` rendered through `@wrongstack/project-surfaces/plugin-ui` (`<PluginViewRenderer>`).
- **REPL / ACP / Headless:** `/panel show` and `/panel list` produce deterministic plain-text or `--json` output.

## Code reference

- `packages/runtime/src/portable-commands/panel.ts` — portable `/panel` command implementation
- `packages/core/src/plugin/plugin-ui.ts` — `PluginUiRegistry`, throttling, depth/size caps, and owner cleanup
- `packages/tui/src/components/plugin-panel-overlay.tsx` — interactive TUI panel modal
- `packages/project-surfaces/src/plugin-ui/PluginViewRenderer.tsx` — shared DOM renderer for WebUI surfaces
- [Plugin Management](../plugin-management.md)
