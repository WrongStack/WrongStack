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

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import type { TodoItem } from '@wrongstack/core/agent';
import { SidebarContent } from '../src/components/sidebar-content.js';
import {
  GoalPanelSidebar,
  KanbanPanelSidebar,
  PlanPanelSidebar,
  QueuePanelSidebar,
  TodosPanelSidebar,
} from '../src/components/sidebar-panels.js';
import { reducer } from '../src/app-reducer.js';
import { displayWidth } from '../src/terminal-width.js';
import { renderRealTty, settle } from './helpers/real-tty.js';
import { createTestState } from './helpers/create-test-state.js';

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
    const longActive =
      'Investigate sticky scrollback regression on narrow terminals';
    const longPending =
      'Add Korean locale strings and rework the autocomplete dictionary';
    const longDone =
      'Survey the audience for their most-wanted feature in v2';
    const todos: TodoItem[] = [
      makeTodo('a', 'in_progress', 'Original', longActive),
      makeTodo('p', 'pending', longPending),
      makeTodo('d', 'completed', longDone),
    ];
    const view = renderRealTty(
      <TodosPanelSidebar todos={todos} width={NARROW_CONTENT_WIDTH} />,
      { columns: NARROW_CONTENT_WIDTH + 4, rows: 40 },
    );

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
    const titles = [
      'Stabilise the sticky scrollback regression on macOS Sonoma and Sequoia',
    ];
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
      <GoalPanelSidebar
        goal={goal}
        coordinatorRunning
        width={NARROW_CONTENT_WIDTH}
      />,
      { columns: NARROW_CONTENT_WIDTH + 4, rows: 30 },
    );

    await settle();
    const frame = view.lastFrame();
    const flat = flatten(frame);

    expect(flat).toContain(
      'Inventory every worktree helper across the workspace modules',
    );
    expect(flat).toContain(
      'Replace the bespoke snapshot fallback with the canonical helper',
    );
    view.unmount();
  });

  it('QueuePanelSidebar keeps the full queued prompt visible at 16 content columns', {
    timeout: 5_000,
  }, async () => {
    const items = [
      {
        id: 1,
        displayText:
          'Refactor the worktree helpers to use the canonical git utilities module',
        blocks: [],
      },
    ];
    const view = renderRealTty(
      <QueuePanelSidebar items={items} width={NARROW_CONTENT_WIDTH} />,
      { columns: NARROW_CONTENT_WIDTH + 4, rows: 30 },
    );

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

    expect(flat).toContain(
      'Diagnose the scrollback regression under narrow terminal widths',
    );
    expect(flat).toContain(
      'Resync the keyboard shortcuts document with the v0.42 release notes',
    );
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
  // maxScrollOffset of exactly 75. The contributing sections are:
  //   context card       4 rows (header + meter + tokens + margin)
  //   model card         3 rows (header + value + margin)
  //   fleet card         3 rows (header + summary + margin; margin=1 here
  //                              because no agent rows follow in default state)
  //   mission card      83 rows (1 header + 8 × SIDEBAR_MISSION_MAX_WRAP_LINES
  //                              + 1 overflow row + 1 margin)
  //   focus indicator    2 rows (visible only when focused)
  //   agents/sessions    0 rows (default state has none)
  //   ─────────────────────────
  //   contentHeight      95 rows
  //   viewport          -20 rows
  //   maxScrollOffset   = 75 rows
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
    expect(s.sidebarScrollOffset).toBe(75);
  });
});
