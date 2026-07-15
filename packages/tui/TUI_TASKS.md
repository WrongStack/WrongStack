# TUI Shortcut and Panel Cleanup Tasks

## Goal

Keep the TUI shortcut registry, help overlay, README documentation, and panel behavior aligned so adding or changing a panel does not create shortcut drift.

## Tasks

1. Extract shared F-key panel metadata
   - Create a single source of truth for F1-F12 panel labels, descriptions, actions, and documentation text.
   - Use it from the F-key picker and HelpOverlay instead of duplicating labels.
   - Keep special aliases such as Ctrl+F/F2, Ctrl+G/F3, and Ctrl+T/F4 represented clearly.

2. Harden F-key launcher behavior
   - Ensure every advertised F-key can be opened directly from the keyboard and from the `/f` picker.
   - Handle actions that require payloads, such as `statuslineOpen`, without unsafe casts.
   - Add focused tests for F5 plan panel and F12 status line picker routing.

3. ✅ Reduce duplicated panel-close logic (done)
   - Route panel opening through reducer actions where possible.
   - Remove duplicated “close other panels” code from `app.tsx` and overlay helpers.
   - Preserve the current mutual-exclusion behavior for F2-F12 panels.
   - **Done**: resize close chain (22→9 lines) and Ctrl+S settings close chain (7→1 line) replaced with `closeAllPanels` dispatch.

4. ✅ Update user-facing documentation (done)
   - Keep `README.md`, HelpOverlay, and the F-key picker synchronized.
   - Document direct F-key shortcuts, Ctrl aliases, `/f`, `/settings`, `/project`, and `/statusline`.
   - Add drift tests where source-readable docs can be tested reliably.
   - **Done**: Updated banner diagram to match the gradient FIGlet + links redesign; updated F3 description to reflect left-right split layout.

5. ✅ Panel-specific shortcut help (already covered)
   - Add panel-local help hints for panels that own keyboard input, especially Process List and Sessions.
   - Make it clear when the chat input remains live behind a panel and when a panel is modal.
   - **Status**: Both Process List (F8) and Sessions Panel (F10) already show full keyboard hints via `KeyCap` in their `MonitorShell` footer — ↑↓, Enter, Del, PgUp/PgDn, etc.

6. ✅ Add regression coverage (already covered)
   - Cover F-key metadata alignment.
   - Cover `/f` launching special-case panels.
   - Cover Esc close behavior and panel mutual exclusion for newly added paths.
   - **Status**: Already covered by `f-key-panels.test.ts` (metadata), `on-panel-open-bridge.test.ts` (launching), `reducer.test.ts` (close/escape), `f-key-monitors-render.test.ts` (rendering), and `help-overlay.test.ts` (alignment).

## Verification checklist

- Run Biome format on touched files.
- Run Biome lint on touched source and tests.
- Run focused Vitest tests for HelpOverlay, F-key handling, and reducer panel behavior.
- Run `packages/tui/tsconfig.json` typecheck.

## Notes

The working tree is shared with other active agents. Avoid staging or committing unrelated changes. Before committing, inspect `git status` and stage only files changed for these tasks.
