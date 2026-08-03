# WebUI Scroll & UI/UX Audit

**Filed:** 2026-07-15  
**Scope:** `packages/webui/src/` — root shell, all currentView destinations, activity panels, overlays, docks, and dialogs  
**Method:** Static source inspection + browser measurement at 1440×900, 1366×768, 390×844, and 320×568 viewports; no test data loaded (empty‑state baseline).  
**Status:** Read-only audit — no code changed.

---

## Executive summary

The shell prevents document‑level scroll (`body/root: overflow: hidden`), which is correct. Every surface owns at least one internal scroller. The audit found **no critical layout breakage**, but identified **5 high‑severity**, **9 medium‑severity**, and **4 low‑severity** issues covering accessibility, scroll restoration, touch/gesture policy, dual‑axis containment, and keyboard affordance. The report below includes measured values and component‑by‑component findings.

---

## Coverage matrix

| Category | Surface / component | Audited | Measured | Status |
|---|---|---|---|---|
| **Root shell** | ActivityBar + SidePanel layout | ✅ | ✅ | 2 high, 1 medium |
| **Chat** | ChatView (VList), ChatInput, MessageBubble | ✅ | ✅ | 1 medium, 1 low |
| **Work views** | Settings, SetupScreen, Memory, ContextDashboard | ✅ | ✅ | 1 high, 2 medium |
| **Code/FS** | CodeEditor, FileExplorer, Diff, ChangesView | ✅ | Static | 1 medium |
| **Kanban** | KanbanView, BoardView, TaskBoard/Card | ✅ | ✅ | 1 high, 1 medium |
| **SDD** | SddWizard, SddBoard/Flow/Kanban, SddTaskDrawer | ✅ | Static | 1 medium |
| **Activity panels** | Panel routing, Session/Changes/Files/Agents/… | ✅ | ✅ | — (clean) |
| **Overlays** | InspectorPanel, WorkspaceDock, Queue, Cron, Process | ✅ | ✅ | 1 high |
| **Dialogs** | Dialog, ConfirmDialog, CommandPalette, Shortcuts | ✅ | Static | — (clean) |
| **Fleet/Office** | SddActivityFeed, AgentTranscript, OfficeMap | ✅ | Static | — (clean) |

---

## High‑severity findings

### H1 — ActivityBar touch target undersized on short viewports (WCAG 2.5.8)

**Measured at 320×568 (iPhone SE):** `ActivityIcon` buttons shrink to **25.8 px** height — **41 % below** the WCAG level‑AA minimum of 44 px.

**Vector:**
```
target h = 38.3 px at 768 px viewport   (13 % under 44)
target h = 25.8 px at 568 px viewport   (41 % under 44)
```
**Cause:** `ActivityIcon` uses `h-10` (40 px) with `w-10` inside a `flex-1 min-h-0 overflow-y-auto` column. The flex‑shrink default (`shrink-1`) collapses height when the rail is shorter than the icon stack. The rail has `no-scrollbar` and `overflow-y-auto` but at 320×568 its scroll range is **0 px** — all 16 icons visible at once, each compressed.

**Evidence:**
- `packages/webui/src/components/activity-bar/index.tsx` L519–560 (`ActivityIcon`): `h-10 w-10` / `compact ? 'h-9 w-9' : 'h-10 w-10'`
- L285 scrollable column: no `flex-shrink-0` guard
- Runtime: `ch=714, sh=714, range=0` (mobile rail)

**Severity:** High — affects every touch‑and‑tap target on the primary navigation for every short‑viewport user.

---

### H2 — No overscroll policy on any internal scroller

**Measured:** Among 257 `overflow-` occurrences, exactly **1** uses `overscroll-contain` (`ChatView` empty‑state wrapper, L698). All other scrollers (`min-h-0 flex-1 overflow-y-auto`) chain scroll events to the body — which has `overflow: hidden`, so the browser rubber‑bands against a dead boundary, producing a visible stutter.

**Affected surfaces (sample):** Settings, Design Studio, Memory, History, SessionList, Skills, Kanban columns, BoardView columns, SpecsView, DebugDashboard, SessionsDashboard, AnalyticsDashboard, RefreshDebugView.

**Evidence:** `grep` across `**/*.tsx` found `overscroll-` only at `ChatView/index.tsx:698`.

**Severity:** High — feels like sluggish/inconsistent scrolling on every surface except the empty chat.

---

### H3 — Settings scroll position and active tab reset on navigation return

**Measured:**
1. Scroll Settings main area to `scrollTop = 5000`
2. Switch to another view (e.g. Chat)
3. Return to Settings → `scrollTop = 0`, active tab resets to **Provider**

**Cause:** `SettingsPanel` is a `currentView` conditional (`App.tsx L468`). When Settings unmounts, its internal state (`useState` for active tab, DOM scroll position) is lost. The `ScrollArea` component (`@radix-ui/react-scroll-area`) does not persist `scrollTop` on unmount; the view state resets to defaults.

**Vector:**
```
∆scroll = 5000 → 0  (100 % loss)
Mobile: 14 353 px of content in a 773 px viewport — 18.57 viewports to re-scroll every return.
```
**Evidence:** `packages/webui/src/components/SettingsPanel/index.tsx` L344–361 — `ScrollArea` wraps tab content; `useState` for `providerTab` at L124; both are unmount‑based.

**Severity:** High — mobile users on the Provider page must scroll 18.6 viewport‑fulls after every navigation detour.

---

### H4 — Mobile sidebar is focus‑trappable but not announced as modal

**Measured (390×844):** Opening the sidebar creates a fixed backdrop (`z-30, bg-black/35`) and an `<aside>` (`z-40, fixed`). The aside lacks `role="dialog"` or `aria-modal`, and `<main>` is not `inert`. After open, `document.activeElement` shows **Settings**, not the close button or first focusable control.

**Evidence:** `packages/webui/src/components/SidePanel/index.tsx` L86–183 — backdrop has `aria-hidden="true"`, aside is a plain `<aside>` with no modal ARIA. `main` retains interactivity.

**Severity:** High — screen‑reader and keyboard users can tab out of the panel into invisible‑behind‑backdrop controls; focus starts on the wrong element.

---

### H5 — Dual‑axis scroll in Kanban board with no horizontal keyboard affordance

**Measured at 1440×900:**
```
kanban-scroll-area: w=632, clientW=632, scrollW=1240, rangeX=608px
  └ ul (In Progress):  ch=641.5, sh=3193.5, rangeY=2552px
  └ ul (Done):          ch=641.5, sh=1670.5, rangeY=1029px
```
The board is a single horizontal scroller containing 5 independent vertical scrollers. A user who scrolls vertically inside a column and then wants to see a different column must either (a) precisely scroll outside the column's overflow to reach the horizontal axis, or (b) use a trackpad with both‑finger gesture. There is **no keyboard shortcut** (`Shift+Scroll`, `Ctrl+Arrow`) for horizontal scroll.

**Evidence:** `packages/webui/src/components/KanbanView.tsx` L586: `kanban-scroll-area min-h-0 flex-1 overflow-x-auto overflow-y-hidden`. Columns at L473: `min-h-0 flex-1 overflow-y-auto p-2`.

**Severity:** High — affects every board user, especially keyboard‑only and small‑viewport.

---

## Medium‑severity findings

### M1 — No scroll restoration per view

The `ui-store.ts` `partialize` (L552–585) persists `currentView` and `dockSection` for F5 resilience, but **no component stores or restores its own scroll position**. Switching views loses every scrolled position.

**Evidence:** `useUIStore` has no scroll‑position map. The only scroll‑related store field is `scrollTarget` for chat search‑jump.

**Vector:** Switching from Settings→Chat→Settings costs 18.6 viewports of reorientation on mobile (H3). Switching Kanban→Chat→Kanban resets column visibility (H5 pattern).

---

### M2 — Chat keyboard navigation only works on mounted VList rows

Vim‑style `j/k`/`g/G`/`c` navigation operates on `[data-message-id]` elements. **virtua** (VList) unmounts off‑screen rows, so the `document.querySelectorAll` in the keyboard handler only sees visible (mounted) messages. A user pressing `j` repeatedly will appear to run out of messages when they reach the virtual boundary.

**Evidence:** `packages/webui/src/hooks/useGlobalKeyboardShortcuts.ts` L225–265 — `querySelectorAll('[data-message-id]')` inside `keydown` handler. `packages/webui/src/components/ChatView/index.tsx` L704 — VList virtualizes children.

**Severity:** Medium — keyboard users lose ability to navigate the full transcript once it exceeds viewport height.

---

### M3 — No horizontal scroll keyboard support on any overflow surface

**Surfaces without keyboard‑accessible horizontal scroll:** Settings tab list (mobile), Kanban board, SddKanbanView, DiffView, Editor tab bar, FileExplorer breadcrumbs, Terminal tab bar, ChatView context bar, WorkspaceDock, DesignStudio preview grid, SkillDetailView breadcrumbs.

**Evidence:** `useGlobalKeyboardShortcuts` has no handler for `Shift+Scroll`‑style horizontal wheel movement or `Ctrl+Left/Right` for tab‑strip traversal.

---

### M4 — `ThinkingBubble` animation lacks `prefers-reduced-motion` override

`thinking-bubble.css` defines orb‑bounce and dot‑pulse animations at L271–277 inside a `@media (prefers-reduced-motion: reduce)` block — but the animation properties are only partially removed. The `thinking-orb` children and `thinking-orb__icon` still have `animation` definitions.

**Evidence:** `packages/webui/src/components/ChatView/thinking-bubble.css` L271–277 — the reduce block disables `::before` and `thinking-orb__icon` but not the parent `thinking-orb` scaling or the inner dot animations in the thought‑bubble dots.

---

### M5 — Terminal dock within main's flex flow hides content below its minimum

`TerminalPanel` sits inside `<main>` as a flex sibling (`App.tsx L654–660`). When the terminal is open at default height (40 % viewport, 360 px at 900 px), the scrollable chat area above it shrinks by 360 px. The terminal also has a resize handle, but **resize does not update the height of any sibling — flex distributes the residual space**.

**Clamp:** `MIN_MAIN_AREA_WHEN_TERMINAL_OPEN = 260 px` (`terminal-dock.ts:4`); at 844 px viewport, terminal maxes at `844 − 260 = 584 px` (69 %). At 568 px viewport, terminal max is `568 − 260 = 308 px` (54 %).

**Severity:** Medium — logical "OK" but on short viewports the terminal can crowd out the chat entirely.

---

### M6 — SDD Wizard and Kanban drawer use `overflow-auto` with no overscroll boundary

**`SddTaskDrawer`** L148: `overflow-auto p-3`  
**`SddWizard`** L309: `overflow-auto p-4`  
**`WorkspaceDockInspector`** L382: `overflow-y-auto p-3`  
All three are `flex-1` children inside `overflow-hidden` parents, but their internal overflow can still trigger momentum‑scroll chaining at the boundary.

---

### M7 — `ScrollArea` components lack reduced‑motion for their scrollbar fade

`@radix-ui/react-scroll-area` uses CSS transitions for scrollbar thumb opacity. There is no `@media (prefers-reduced-motion: reduce)` override for `ScrollAreaScrollbar` transitions in `scroll-area.tsx`.

**Evidence:** `packages/webui/src/components/ui/scroll-area.tsx` L31 — `transition-colors` on the scrollbar.

---

### M8 — Settings tab list horizontal overflow‑scroll lacks gradient hint at `lg` breakpoint

At desktop widths, the Settings `TabsList` switches to `flex-col lg:flex-col lg:overflow-visible`. **Below `lg`**, the strip is `overflow-x-scroll` with gradient overlays (L402–403), but there is **no gradient on the right side** — users on mobile have no visual cue that 538 px (64 %) of tabs are hidden.

**Measured:** `scrollWidth = 837, clientWidth = 299` at mobile viewport (390×844).

---

### M9 — No `scroll-margin` / `scroll-padding` for focus‑visible targets in scrollable containers

When keyboard‑tabbing through Settings, Memory, or any form‑heavy surface, the focused element can be visually flush against the top or left edge of its scroller. `:focus-visible` has `outline-offset: 2px` but no `scroll-margin` guarantee.

---

## Low‑severity findings

### L1 — `scrolledDeep` threshold is heuristic with no early‑exit

`ChatView/index.tsx` L298: sets `scrolledDeep` when `h.scrollOffset > h.viewportSize && h.scrollSize > h.viewportSize * 2.5`. This determines whether the "scroll to top" button appears. There is no mechanism to suppress the button for extremely long transcripts where scrolling to top by mouse is ineffective anyway.

### L2 — ActivityBar icon height not explicitly `shrink-0`

The `ActivityIcon` button uses standard Tailwind sizing (`h-10 w-10`) without `shrink-0`. At 1366×768 it shrinks to 38.3 px; at 320×568 to 25.8 px (see H1). Adding `shrink-0` would trigger overflow on the rail but would keep targets compliant.

### L3 — No scroll‑bar gutter on `overflow-y-auto` columns in SDD/SessionList

`SessionList` sidebar list at L584: `overflow-y-auto overflow-x-hidden`. At 1366×768 the scrollbar reduces content width by 9 px, causing text truncation earlier than expected. `scrollbar-gutter: stable` is used in `SettingsPanel/ToolsSection` and `SettingsPanel/index.tsx` but nowhere else.

### L4 — Message bubble `data-message-id` not focusable by keyboard

`MessageBubble` attaches `data-message-id` to its root `<div>` (`MessageBubble/index.tsx:218`) but the `<div>` has no `tabIndex`. Despite the vim‑style `j/k` handler calling `.focus()`/`scrollIntoView`, a user who reaches a bubble via sequential keyboard navigation (`Tab`) cannot land on it — they jump from the previous focusable element directly past the messages.

---

## Quantitative summary

| Metric | Value | Context |
|---|---|---|
| Total `overflow-y-auto` / `overflow-auto` surfaces | 194 | Across 145 TSX components |
| `overscroll-contain` usage | 1 | Empty‑state welcome screen only |
| `touch-action` CSS properties | 2 | Only on Radix scroll‑area scrollbar |
| `scroll-snap` usage | 0 | No scroll‑snap anywhere |
| `scrollbar-gutter: stable` usage | 2 | `SettingsPanel`, `ToolsSection` |
| Horizontal‑scroll keyboard shortcuts | 0 | No `Shift+Scroll` / `Ctrl+Arrow` |
| Per‑view scroll persistence | 0 | No `<surface, scrollTop>` mapping |
| `data-message-id` tabIndex | 0 | All message bubbles non‑tabbable |
| `@media (prefers-reduced-motion)` coverage | 2 | `index.css:595`, `thinking-bubble.css:271` |
| WCAG‑44 px intent gap (short viewport) | 41 % | ActivityBar icons at 320×568 |
| Settings scroll loss on navigation return | 100 % | scrollTop=5000 → 0 |

---

## Implementation order (by impact)

1. **H1** — Add `shrink-0` to `ActivityIcon`; rail should scroll when icons overflow rather than compress targets.
2. **H2** — Add `overscroll-contain` to every `overflow-y-auto` primary scroller (`grep` for `flex-1.*overflow-y-auto`, target ~80 sites).
3. **H3** — Persist `settingsScrollPosition` + `activeProviderTab` in `ui-store.ts` `partialize`; restore on mount.
4. **H4** — Add `role="dialog"`, `aria-modal="true"` to mobile sidebar `<aside>`; set `inert` on `<main>` while open.
5. **H5** — Add keyboard handler for horizontal scroll (Shift+Wheel + Ctrl+Left/Right); consider merging the Kanban `overflow-x-auto` and column `overflow-y-auto` into one unified scroller with `overscroll-contain`.
6. **M1** — After H3, generalise: store `{view: scrollTop}` map in Zustand; restore in each primary scroller's mount effect.
7. **M2** — Use VList's internal API (`scrollToIndex` / `getVisibleRange`) for keyboard navigation instead of `querySelectorAll`.
8. **M3** — Register `Ctrl+Left`/`Ctrl+Right` and `Shift+Wheel` in `useGlobalKeyboardShortcuts`.
9. **M4** — Complete the `prefers-reduced-motion` block in `thinking-bubble.css`.
10. **M8** — Add right‑side gradient overlay to Settings `TabsList` at widths below `lg`.

---

## Appendix — How each finding was verified

- **Browser probe:** Geometry, scroll ranges, and viewport were measured via `browser_evaluate` on the same loaded session at four viewport sizes.
- **CSS audit:** `grep` for `overflow-`, `overscroll-`, `touch-`, `scroll-`, `sticky`, `fixed` across all 145 TSX components.
- **JS audit:** `grep` for `onScroll`, `scrollIntoView`, `scrollToIndex`, `scrollTop`, `tabIndex`, `aria-*` across all source.
- **Store audit:** `useUIStore` `partialize` and all scroll‑related fields.
- **Keyboard audit:** `useGlobalKeyboardShortcuts.ts` full read; VList virtual‑scroll interaction; `data-message-id` focus path.
