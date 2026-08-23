// Sidebar worklist wrap test — verifies that worklist items (Todos, Plan
// steps, Kanban card titles, Goal deliverables, Queue) keep their full text
// visible at narrow sidebar widths by soft-wrapping onto multiple lines
// instead of pre-truncating with an ellipsis.
//
// At the minimum 20-column sidebar (16 content columns) long todo/plan/kanban
// titles used to be hidden behind a `…` after `inner - N` columns. The fix
// passes the full string to Ink and lets it wrap to the available width;
// vertical overflow is owned by RightSidebar's overflowY="hidden" viewport.
//
// See: `packages/tui/src/components/sidebar-content.tsx`
//      `packages/tui/src/components/sidebar-panels.tsx`

import type { TodoItem } from '@wrongstack/core/agent';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import type { Settings } from '../src/app-settings-type.js';
import { resolveAppSidebarLayout } from '../src/app-ui-state.js';
import { SidebarContent } from '../src/components/sidebar-content.js';
import {
  GoalPanelSidebar,
  KanbanPanelSidebar,
  PlanPanelSidebar,
  QueuePanelSidebar,
  TodosPanelSidebar,
} from '../src/components/sidebar-panels.js';
import { displayWidth } from '../src/terminal-width.js';
import { createTestState } from './helpers/create-test-state.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

// 20-column sidebar → 16 usable content columns (per `computeSidebarContentWidth`).
const NARROW_CONTENT_WIDTH = 16;

function makeTodo(
  id: string,
  status: TodoItem['status'],
  content: string,
  activeForm?: string,
): TodoItem {
  return { id, status, content, activeForm };
}

/**
 * Build a "flattened" form of the frame with every whitespace run collapsed
 * to a single space. The right-sidebar variants render through a `RightSidebar`
 * Box with a `╭─╮` frame, so each line has padding (and intra-cell spacing)
 * that survives a simple newline-flatten. Collapsing all whitespace runs is
 * safe because the substrings we compare are plain prose (no double-spaces or
 * leading whitespace that carry semantic meaning).
 */
function flatten(frame: string): string {
  return frame.replace(/\s+/g, ' ');
}

describe('sidebar worklist items wrap onto multiple lines on narrow rails', () => {
  it('TodosPanelSidebar keeps the full todo label visible at 16 content columns (no ellipsis truncation)', {
    timeout: 5_000,
  }, async () => {
    const longActive = 'Investigate sticky scrollback regression on narrow terminals';
    const longPending = 'Add Korean locale strings and rework the autocomplete dictionary';
    const longDone = 'Survey the audience for their most-wanted feature in v2';
    const todos: TodoItem[] = [
      makeTodo('a', 'in_progress', 'Original', longActive),
      makeTodo('p', 'pending', longPending),
      makeTodo('d', 'completed', longDone),
    ];
    const view = renderRealTty(<TodosPanelSidebar todos={todos} width={NARROW_CONTENT_WIDTH} />, {
      columns: NARROW_CONTENT_WIDTH + 4,
      rows: 40,
    });

    await settle();
    const frame = view.lastFrame();
    const flat = flatten(frame);

    // Every full label must appear in the rendered frame — substring matches
    // on the joined form ignore Ink's line-break placement.
    expect(flat).toContain(longActive);
    expect(flat).toContain(longPending);
    expect(flat).toContain(longDone);

    // The old failing behavior pre-truncated to ~12 cols with an ellipsis; the
    // ellipsis must NOT appear on any worklist row in this frame.
    expect(frame).not.toContain('…');

    // Each rendered line must still fit the sidebar width (border+padding).
    for (const line of view.lines()) {
      expect(displayWidth(line)).toBeLessThanOrEqual(NARROW_CONTENT_WIDTH + 4);
    }
    view.unmount();
  });

  it('PlanPanelSidebar keeps the full plan-item title visible at 16 content columns', {
    timeout: 5_000,
  }, async () => {
    const items = [
      {
        id: 'long-active',
        title: 'Polish the narrow-rail wrap behavior so plan steps stay legible',
        status: 'in_progress' as const,
      },
      {
        id: 'long-open',
        title: 'Survey users about the long-context tier and capture quotes',
        status: 'open' as const,
      },
    ];
    const view = renderRealTty(
      <PlanPanelSidebar
        openCount={1}
        inProgressCount={1}
        doneCount={0}
        items={items}
        width={NARROW_CONTENT_WIDTH}
      />,
      { columns: NARROW_CONTENT_WIDTH + 4, rows: 30 },
    );

    await settle();
    const frame = view.lastFrame();
    const flat = flatten(frame);

    // `noUncheckedIndexedAccess` makes items[i] `T | undefined`; destructure so
    // the asserts read cleanly and the test typechecks under strict mode.
    const [active, open] = items;
    expect(active).toBeDefined();
    expect(open).toBeDefined();
    expect(flat).toContain(active!.title);
    expect(flat).toContain(open!.title);
    expect(frame).not.toContain('…');
    view.unmount();
  });

  it('KanbanPanelSidebar keeps the full active-card title visible at 16 content columns', {
    timeout: 5_000,
  }, async () => {
    const titles = ['Stabilise the sticky scrollback regression on macOS Sonoma and Sequoia'];
    const columns = [{ name: 'Backlog', count: 1 }];
    const view = renderRealTty(
      <KanbanPanelSidebar
        columns={columns}
        totalActive={1}
        activeCardTitles={titles}
        width={NARROW_CONTENT_WIDTH}
      />,
      { columns: NARROW_CONTENT_WIDTH + 4, rows: 30 },
    );

    await settle();
    const frame = view.lastFrame();
    const flat = flatten(frame);

    expect(flat).toContain(titles[0]);
    expect(frame).not.toContain('…');
    view.unmount();
  });

  it('GoalPanelSidebar keeps the full deliverable text visible at 16 content columns', {
    timeout: 5_000,
  }, async () => {
    const goal = {
      goal: 'Ship the Worktree Hygiene refactor',
      goalState: 'active' as const,
      iterations: 0,
      progress: 0,
      deliverables: [
        '[ ] Inventory every worktree helper across the workspace modules',
        '[x] Replace the bespoke snapshot fallback with the canonical helper',
      ],
    };
    const view = renderRealTty(
      <GoalPanelSidebar goal={goal} coordinatorRunning width={NARROW_CONTENT_WIDTH} />,
      { columns: NARROW_CONTENT_WIDTH + 4, rows: 30 },
    );

    await settle();
    const frame = view.lastFrame();
    const flat = flatten(frame);

    expect(flat).toContain('Inventory every worktree helper across the workspace modules');
    expect(flat).toContain('Replace the bespoke snapshot fallback with the canonical helper');
    view.unmount();
  });

  it('QueuePanelSidebar keeps the full queued prompt visible at 16 content columns', {
    timeout: 5_000,
  }, async () => {
    const items = [
      {
        id: 1,
        displayText: 'Refactor the worktree helpers to use the canonical git utilities module',
        blocks: [],
      },
    ];
    const view = renderRealTty(<QueuePanelSidebar items={items} width={NARROW_CONTENT_WIDTH} />, {
      columns: NARROW_CONTENT_WIDTH + 4,
      rows: 30,
    });

    await settle();
    const frame = view.lastFrame();
    const flat = flatten(frame);

    // `noUncheckedIndexedAccess` makes items[0] `T | undefined`; assert the
    // presence explicitly so the test typechecks under strict mode.
    expect(items[0]).toBeDefined();
    expect(flat).toContain(items[0]!.displayText);
    expect(frame).not.toContain('…');
    view.unmount();
  });

  it('SidebarContent mission queue keeps the full todo content visible at 16 content columns', {
    timeout: 5_000,
  }, async () => {
    const todos: TodoItem[] = [
      makeTodo(
        'm1',
        'in_progress',
        'Original',
        'Diagnose the scrollback regression under narrow terminal widths',
      ),
      makeTodo(
        'm2',
        'pending',
        'Resync the keyboard shortcuts document with the v0.42 release notes',
      ),
    ];
    // ink-testing-library renders the whole frame (no real layout) — sufficient
    // to confirm the pre-truncation was removed and the full label flows through.
    // The real-layout coverage is exercised by the renderRealTty variants above.
    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1, max: 10 },
        entries: {},
        fleetCounts: undefined,
        width: NARROW_CONTENT_WIDTH + 4,
        showSwarmSection: true,
        todos,
      }),
    );
    const frame = lastFrame() ?? '';
    const flat = flatten(frame);

    expect(flat).toContain('Diagnose the scrollback regression under narrow terminal widths');
    expect(flat).toContain('Resync the keyboard shortcuts document with the v0.42 release notes');
    // Both todos are non-completed, so the badge is 0/2.
    expect(frame).toContain('0/2');
  });
});

describe('sidebar scroll clamp reserves enough range for wrapped mission rows', () => {
  // Regression guard for `computeMaxSidebarScroll()` (reducers/workspace-panels.ts):
  // the mission queue now wraps labels onto multiple Ink rows, so the scroll
  // budget must cover the worst-case expansion or the bottom rows become
  // unreachable behind `RightSidebar`'s overflowY="hidden" viewport.
  // Without this budget, focused-sidebar ↑↓ can scroll past the bottom into
  // blank space instead of revealing the last wrapped mission.
  //
  // Pinned empirical value: with the default test state (no routed panels,
  // no running subagents, sidebar focused) the reducer computes a
  // maxScrollOffset of exactly 82. The contributing sections are:
  //   model/context hero 14 rows (stage + identity + meters + composition + margin)
  //   fleet card          3 rows (header + summary + margin; margin=1 here
  //                               because no agent rows follow in default state)
  //   mission card       83 rows (1 header + 8 × SIDEBAR_MISSION_MAX_WRAP_LINES
  //                               + 1 overflow row + 1 margin)
  //   focus indicator     2 rows (visible only when focused)
  //   system vitals       5 rows (SYSTEM card header + 3 metrics + margin)
  //   agents/sessions     0 rows (default state has none)
  //   ─────────────────────────
  //   contentHeight      107 rows  (+5 for SYSTEM vitals card)
  //   viewport           -20 rows
  //   maxScrollOffset    = 87 rows
  // If you change SIDEBAR_MISSION_MAX_WRAP_LINES or any section reserve in
  // reducers/workspace-panels.ts, this assertion must move with it.

  it('allows scrolling far enough to reveal 8 wrapped mission rows at the minimum sidebar', () => {
    // Default test state: minimal fleet (just leader, no running subagents)
    // and no routed panels. Route the swarm panel to 'sidebar' so the
    // mission queue card is the substantial content; the reducer deep-merges
    // panelPositions partials so other panels stay at their defaults.
    let s = reducer(createTestState(), {
      type: 'settingsValueSet',
      patch: { panelPositions: { fleet: 'sidebar' } },
    });
    // Focus so the scroll reducer accepts scroll deltas.
    s = reducer(s, { type: 'toggleSidebarFocus' });
    // Scroll repeatedly — the reducer clamps at computeMaxSidebarScroll().
    for (let i = 0; i < 200; i++) {
      s = reducer(s, { type: 'sidebarScroll', delta: 1 });
    }
    // With the SYSTEM vitals card (+5 rows) and the prompt cache card
    // (+11 rows), the total is 14 (hero) + 11 (cache) + 5 (system)
    // + 3 (fleet: empty, header+margin) + 2 (focus)
    // + 83 (mission) = 118, minus the 20-row viewport = 98 max.
    expect(s.sidebarScrollOffset).toBe(98);
  });

  // Regression for Medium #2 (effectiveSwarmOnSidebar dual source): when
  // the caller threads the effective swarm-panel boolean (picker draft
  // when open, persisted liveSettings otherwise), the reducer's
  // mission-queue reservation fires even if the picker draft says
  // 'bottom' (e.g. the config was set without opening the picker).
  it('reserves mission-queue rows when effectiveSwarmOnSidebar=true even if the picker draft is "bottom"', () => {
    let s = createTestState();
    // Picker draft stays at default 'bottom' (createTestState default).
    s = reducer(s, { type: 'toggleSidebarFocus' });
    for (let i = 0; i < 200; i++) {
      s = reducer(s, {
        type: 'sidebarScroll',
        delta: 1,
        effectiveSwarmOnSidebar: true,
      });
    }
    // Same 98-row max as the picker-draft case (the effective boolean
    // produces the same content height when both report 'sidebar').
    expect(s.sidebarScrollOffset).toBe(98);
  });

  // Regression for Medium #1 (twin-row viewport subtraction): when one
  // routed twin is mounted above SidebarContent, the reducer subtracts
  // `sidebarTwinRowCount` from `viewportHeight` so the user can't scroll
  // past the rendered content end into blank space. With one twin (8
  // rows reserved), the effective viewport is 20 − 8 = 12 and the max
  // scroll is 107 − 12 = 95.
  //
  // Note: the `effectiveSwarmOnSidebar: true` field on every scroll
  // already drives the 107-row height (1 header + 8 × 10 + 1 overflow
  // + 1 margin = 83 mission rows + 24 chrome including SYSTEM vitals),
  // so we don't need to pre-set `panelPositions.fleet: 'sidebar'` in a `settingsValueSet`
  // patch — the effective boolean carries the same information.
  it('subtracts sidebarTwinRowCount from the viewport when computing the scroll clamp', () => {
    let s = createTestState();
    s = reducer(s, { type: 'toggleSidebarFocus' });
    for (let i = 0; i < 200; i++) {
      s = reducer(s, {
        type: 'sidebarScroll',
        delta: 1,
        viewportHeight: 20,
        sidebarTwinRowCount: 8,
        effectiveSwarmOnSidebar: true,
      });
    }
    // contentHeight 118 − viewport 12 (20−8 twin) = 106.
    expect(s.sidebarScrollOffset).toBe(106);
  });

  // Mirror test for the `??` fallback in `computeMaxSidebarScroll`:
  // when `effectiveSwarmOnSidebar` is NOT provided, the reducer must
  // read the picker draft (`state.settingsPicker.showAgentSwarmPanel`).
  // With the default state (picker draft = 'bottom'), the mission
  // queue reservation is absent, so the content height is the
  // hero + cache + system vitals + focus = 32 rows (14 + 11 + 5 + 2),
  // viewport 20 → max scroll = 12. A future flip of the `??` to a
  // hardcoded `true` (or default `false`) would be caught by this
  // assertion diverging from 12.
  it('falls back to the picker draft when effectiveSwarmOnSidebar is omitted', () => {
    let s = createTestState();
    s = reducer(s, { type: 'toggleSidebarFocus' });
    for (let i = 0; i < 200; i++) {
      s = reducer(s, { type: 'sidebarScroll', delta: 1 });
    }
    // contentHeight 32 (14 hero + 11 cache + 5 system + 2 focus) − viewport 20 = 12.
    expect(s.sidebarScrollOffset).toBe(12);
  });

  // End-to-end regression for the dual-source `effectiveSwarmOnSidebar`
  // contract: `resolveSidebarLayout` must OR both
  // `panelPositions.fleet === 'sidebar'` AND the legacy
  // `showAgentSwarmPanel === 'sidebar'` flag from `liveSettings`,
  // matching the renderer's source-of-truth at `app-view.tsx:897-899`.
  // Without the legacy field, a config-only swarm mode (no recent
  // picker open) would render the mission card but the scroll-clamp
  // would under-reserve, hiding the bottom mission rows.
  it('resolveAppSidebarLayout returns effectiveSwarmOnSidebar=true when only the legacy showAgentSwarmPanel field is "sidebar"', () => {
    const state = createTestState();
    // No panelPositions override (default = 'bottom' for fleet). A legacy
    // `liveSettings.showAgentSwarmPanel === 'sidebar'` config alone must
    // flip the flag.
    const layout = resolveAppSidebarLayout(
      state,
      80,
      { showAgentSwarmPanel: 'sidebar' } as unknown as Settings,
      false, // mailboxPanelOpen
    );
    expect(layout.effectiveSwarmOnSidebar).toBe(true);
  });
});
