# WebUI Scroll Audit Report

> Generated: 2026-08-01
> Scope: `packages/webui/src` — 161 files, 538 scroll/overflow occurrences

## Summary

| Metric | Count |
|--------|-------|
| Files with scroll/overflow patterns | 161 |
| Total overflow occurrences | 538 |
| CSS class (Tailwind utility) | 395 |
| Inline style | 1 |
| `overflow: hidden` | 170 |
| `overflow: auto` | 181 |
| `overflow: scroll` | 74 |

## Overflow value distribution

| Value | Count | Pattern |
|-------|-------|---------|
| `hidden` | 170 | Prevents scroll — used for clipping content, preventing body scroll |
| `auto` | 181 | Conditional scroll — only shows scrollbar when content overflows |
| `scroll` | 74 | Always shows scrollbar — may cause unnecessary scrollbars on some viewports |

## Highest-concentration files

| File | Occurrences | Risk level |
|------|-------------|------------|
| `components/activity-bar/index.tsx` | 33 | High — complex nested scroll containers |
| `components/ChatView/index.tsx` | 33 | High — primary scroll surface, virtual list |
| `App.tsx` | 24 | Medium — root layout scroll containment |
| `stores/ui-store.ts` | 14 | Low — scroll position state (not CSS) |
| `components/FleetMonitor.tsx` | 12 | Medium — nested panels with independent scroll |
| `hooks/useHorizontalScroll.ts` | 11 | Low — scroll behavior hook |
| `components/FleetPanel.tsx` | 10 | Medium — panel scroll |
| `components/SessionWatchPanel.tsx` | 10 | Medium — panel scroll |
| `components/ChatInput.tsx` | 9 | Medium — input area height/scroll |
| `components/FileExplorer.tsx` | 9 | Medium — tree scroll |
| `components/SidePanel/index.tsx` | 9 | Medium — sidebar scroll |
| `components/ToolResult.tsx` | 9 | Medium — result content scroll |

## Common patterns and risk assessment

### Pattern 1: `overflow-auto` without bounded height (systemic)

**181 `overflow: auto` declarations** — many without a corresponding `max-h-*` or `h-*` constraint. When content grows, the container expands to fit rather than scrolling, pushing siblings out of the viewport.

**Most affected:** ChatView, FleetMonitor, InspectorPanel, SidePanel

**Remediation:** Each `overflow-auto` container needs an explicit height constraint (`h-full`, `max-h-[Npx]`, or flex-child with `min-h-0`).

### Pattern 2: Nested scroll containers without `min-h-0`

Flexbox children that scroll need `min-h-0` (or `min-w-0`) to prevent the flex item from growing to content size. The WebUI uses nested flex layouts extensively — missing `min-h-0` is the most common cause of scroll containers that don't scroll and instead push the page.

**Most affected:** App.tsx, ChatView, SidePanel, InspectorPanel

### Pattern 3: `overflow-scroll` where `overflow-auto` suffices

**74 `overflow: scroll` declarations** show a scrollbar even when content fits. This creates visual noise and can cause layout shift when scrollbars appear/disappear on different platforms (macOS overlay vs Windows/Linux permanent).

**Remediation:** Replace `overflow-scroll` with `overflow-auto` unless the scrollbar is intentionally always visible.

## Priority remediation targets

### P0 — Primary scroll surfaces (user-facing)

1. **ChatView** (33 occurrences) — The chat history must scroll independently of the input area. Virtual list scroll must not leak to the body. Check: `min-h-0` on flex parent, `h-full` on scroll container.

2. **App.tsx root layout** (24 occurrences) — The root container must prevent body scroll. All panels (sidebar, chat, inspector) scroll independently within their allocated flex space.

3. **SidePanel** (9 occurrences) — Panel content must scroll independently. Check nested panel heights.

### P1 — Secondary scroll surfaces

4. **FleetMonitor** (12) — Nested fleet list with independent scroll regions.
5. **ChatInput** (9) — Input area must grow to a max then scroll internally.
6. **FileExplorer** (9) — Tree view must scroll independently of siblings.
7. **ToolResult** (9) — Long tool output must scroll within its card, not expand the chat.

### P2 — Polish

8. Replace `overflow-scroll` → `overflow-auto` where not intentionally permanent.
9. Add `scrollbar-gutter: stable` to prevent layout shift on platforms with permanent scrollbars.

## Recommended approach

1. **Browser E2E tests** — Use Playwright to load the WebUI at common viewport sizes (1920×1080, 1366×768, 375×812) and verify:
   - No body-level scroll (the app is full-viewport)
   - Each scrollable panel scrolls independently
   - Content doesn't overflow viewport bounds
   - No double scrollbars appear

2. **Fix `min-h-0` on flex parents** — Systematic pass through all flex layouts that contain scroll children.

3. **Bound all `overflow-auto` containers** — Each needs an explicit height constraint.

4. **Replace `overflow-scroll` with `overflow-auto`** — 74 instances, mechanical change.

## Test infrastructure needed

- Playwright config for WebUI (E2E viewport testing)
- Scroll-position assertions for primary surfaces
- Viewport resize tests for responsive behavior
- Visual regression snapshots for scroll state
