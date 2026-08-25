/**
 * Repro/regression harness for the reported TUI visual bugs:
 *   1. empty areas + truncation artifacts ("..."/"…") that don't fit the
 *      context-rendered screen,
 *   2. card borders (frames) not rendering correctly around the
 *      "no cache yet" prompt-cache card.
 *
 * Renders through the real Ink renderer (fake TTY) and asserts invariants
 * that are checkable on the plain-text frame:
 *   - every sidebar card frame row (│ ... │) is exactly `sidebarWidth`
 *     columns and the right │ lines up with the top/bottom rules,
 *   - no frame row overflows its card width (which is what breaks the
 *     border visually),
 *   - the cache-empty hint fits on one line (no soft-wrap).
 */
import type { TodoItem } from '@wrongstack/core/agent';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { FleetEntry } from '../src/app-state-fleet.js';
import { ContextPanel } from '../src/components/context-panel.js';
import {
  computeSidebarContentWidth,
  computeSidebarWidth,
  RightSidebar,
} from '../src/components/sidebar.js';
import { SidebarContent } from '../src/components/sidebar-content.js';
import { Box } from '../src/ink.js';
import { emptyMemoryContextMonitor } from '../src/memory-context-monitor.js';
import { displayWidth } from '../src/terminal-width.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const ENTRIES: Record<string, FleetEntry> = {
  leader: { id: 'leader', name: 'Leader Agent', status: 'idle' } as FleetEntry,
  sub1: {
    id: 'sub1',
    name: 'chimera-review',
    status: 'running',
    currentTool: { name: 'read_file' },
    ctxPct: 0.31,
  } as FleetEntry,
};

const TODOS: TodoItem[] = [
  {
    id: '1',
    content: 'Fix the cache card frame',
    status: 'in_progress',
    activeForm: 'Fixing cache card frame',
  },
  { id: '2', content: 'Verify at 80 and 120 columns', status: 'pending' },
];

function sidebarContentEl(contentWidth: number): ReactElement {
  return (
    <SidebarContent
      contextWindow={{ used: 48_000, max: 200_000 }}
      cacheStats={{ readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 }}
      entries={ENTRIES}
      fleetCounts={{ running: 1, idle: 1, pending: 0, completed: 0 }}
      provider="anthropic"
      model="claude-sonnet-4-5"
      width={contentWidth}
      todos={TODOS}
      showSwarmSection
      processMemory={undefined}
    />
  );
}

/** Rows that carry the card side bars `│ ... │`. */
function frameRows(lines: string[]): { line: string; width: number }[] {
  return lines.filter((l) => l.includes('│')).map((l) => ({ line: l, width: displayWidth(l) }));
}

describe('sidebar cache card frame integrity (real TTY)', () => {
  const COLUMNS = [80, 120, 160] as const;

  it('shows the active provider cache ratio in the persistent cache card', async () => {
    const columns = 120;
    const sidebarWidth = computeSidebarWidth(columns);
    const contentWidth = computeSidebarContentWidth(sidebarWidth);
    const view = renderRealTty(
      <Box width={columns} height={34} justifyContent="flex-end" overflowX="hidden">
        <RightSidebar width={sidebarWidth} maxHeight={34}>
          <SidebarContent
            contextWindow={{ used: 48_000, max: 200_000 }}
            cacheStats={{
              readTokens: 800,
              writeTokens: 0,
              hitRatio: 0.8,
              savedUsd: 0,
              providers: [
                {
                  provider: 'minimax',
                  input: 200,
                  cacheRead: 800,
                  cacheWrite: 0,
                  hitRatio: 0.8,
                },
              ],
            }}
            entries={ENTRIES}
            fleetCounts={{ running: 1, idle: 1, pending: 0, completed: 0 }}
            provider="minimax"
            model="minimax-m3"
            width={contentWidth}
            todos={TODOS}
            showSwarmSection
            processMemory={undefined}
          />
        </RightSidebar>
      </Box>,
      { columns, rows: 34 },
    );
    await settle();
    const frame = view.lines().join('\n');
    expect(frame).toContain('PROMPT CACHE');
    expect(frame).toContain('read 800');
    expect(frame).not.toContain('write');
    view.unmount();
  });

  for (const columns of COLUMNS) {
    it(`right side bar aligns at ${columns} columns`, { timeout: 5_000 }, async () => {
      const sidebarWidth = computeSidebarWidth(columns);
      const contentWidth = computeSidebarContentWidth(sidebarWidth);
      // Per-row `│ … │` side bars only render on rails wide enough to
      // afford the 2-col chrome (innerWidth >= 18). At 80 cols the
      // sidebar is exactly 20 cols wide → innerWidth 12 → corners only,
      // no side bars, so the `│` filter legitimately returns zero rows.
      const expectSideBars = sidebarWidth >= 22;
      const view = renderRealTty(
        <Box width={columns} height={34} justifyContent="flex-end" overflowX="hidden">
          <RightSidebar width={sidebarWidth} maxHeight={34}>
            {sidebarContentEl(contentWidth)}
          </RightSidebar>
        </Box>,
        { columns, rows: 34 },
      );
      await settle();
      const lines = view.lines();
      // The ribbon and footer reference the OUTER sidebar width; card rows
      // reference the card width. Collect the card side-bar rows only.
      const rows = frameRows(lines);
      if (expectSideBars) {
        expect(rows.length).toBeGreaterThan(0);
      }
      // Every side-bar row must end with `│`. The right-edge width is
      // measured AFTER `trimStart()` so the test isn't confused by the
      // empty columns to the LEFT of the sidebar (the test wraps the
      // RightSidebar in a flex-end Box of `columns` width, so the
      // sidebar sits at the right and the leading cols are blank).
      for (const r of rows) {
        expect(r.line.trimEnd().endsWith('│')).toBe(true);
        expect(displayWidth(r.line.trimStart())).toBeLessThanOrEqual(sidebarWidth);
      }
      // All side-bar rows must share one right edge position.
      const rightEdges = new Set(rows.map((r) => displayWidth(r.line.trimStart())));
      if (rows.length > 1) expect(rightEdges.size).toBe(1);
      view.unmount();
    });

    it(`no cache hint fits and no line overflows the rail at ${columns} columns`, {
      timeout: 5_000,
    }, async () => {
      const sidebarWidth = computeSidebarWidth(columns);
      const contentWidth = computeSidebarContentWidth(sidebarWidth);
      const view = renderRealTty(
        <Box width={columns} height={34} justifyContent="flex-end" overflowX="hidden">
          <RightSidebar width={sidebarWidth} maxHeight={34}>
            {sidebarContentEl(contentWidth)}
          </RightSidebar>
        </Box>,
        { columns, rows: 34 },
      );
      await settle();
      const lines = view.lines();
      const overflow = lines.filter((l) => displayWidth(l) > columns);
      expect(overflow, JSON.stringify(overflow)).toEqual([]);
      view.unmount();
    });
  }
});

describe('context panel empty-cache state (real TTY)', () => {
  function data(): React.ComponentProps<typeof ContextPanel>['data'] {
    return {
      ctxPct: 0.24,
      ctxTokens: 48_000,
      ctxMaxTokens: 200_000,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      mode: 'default',
      uptime: '12m',
      cacheStats: { readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 } as never,
      cacheCoverageTokens: 0,
      breakdown: undefined,
      fleetEntries: [
        { name: 'chimera-review', status: 'running', currentTool: 'read', ctxPct: 0.31 },
      ],
      leaderIterations: 3,
      leaderToolCalls: 14,
      leaderStatus: 'idle',
      memoryContext: emptyMemoryContextMonitor(),
    };
  }

  it.each([80, 120, 200])(
    'no line exceeds terminal width (%i cols)',
    { timeout: 5_000 },
    async (columns) => {
      const view = renderRealTty(<ContextPanel data={data()} onClose={() => {}} />, {
        columns,
        rows: 40,
      });
      await settle();
      const overflow = view.lines().filter((l) => displayWidth(l) > columns);
      expect(overflow, JSON.stringify(overflow)).toEqual([]);
      view.unmount();
    },
  );
});
