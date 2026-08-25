import { describe, it } from 'vitest';
import type { TodoItem } from '@wrongstack/core/agent';
import type { ReactElement } from 'react';
import { Box } from '../src/ink.js';
import { computeSidebarWidth, RightSidebar } from '../src/components/sidebar.js';
import { SidebarContent } from '../src/components/sidebar-content.js';
import { ContextPanel } from '../src/components/context-panel.js';
import { emptyMemoryContextMonitor } from '../src/memory-context-monitor.js';
import type { FleetEntry } from '../src/app-state-fleet.js';
import { displayWidth } from '../src/terminal-width.js';
import { renderRealTty, settle } from './helpers/real-tty.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DUMP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.temp_files');

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
  { id: '1', content: 'Fix the cache card frame', status: 'in_progress' },
  { id: '2', content: 'Verify at 80 and 120 columns', status: 'pending' },
];

describe('debug dump', () => {
  it('dumps real app frames', { timeout: 5_000 }, async () => {
    const out: string[] = [];
    for (const columns of [80, 100, 120] as const) {
      const sidebarWidth = computeSidebarWidth(columns);
      // Mirror app-view-sidebar.tsx: SidebarContent receives the OUTER width.
      const el = (
        <SidebarContent
          contextWindow={{ used: 48_000, max: 200_000 }}
          cacheStats={{ readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 }}
          entries={ENTRIES}
          fleetCounts={{ running: 1, idle: 1, pending: 0, completed: 0 }}
          provider="anthropic"
          model="claude-sonnet-4-5"
          width={sidebarWidth}
          todos={TODOS}
          showSwarmSection
        />
      ) as ReactElement;
      const view = renderRealTty(
        <Box width={columns} height={34} justifyContent="flex-end" overflowX="hidden">
          <RightSidebar width={sidebarWidth} maxHeight={34}>
            {el}
          </RightSidebar>
        </Box>,
        { columns, rows: 34 },
      );
      await settle();
      out.push(`=== SIDEBAR ${columns} cols (sw=${sidebarWidth}) ===`);
      for (const [i, line] of view.lines().entries()) {
        out.push(`${String(i).padStart(2)} [${String(displayWidth(line)).padStart(3)}] |${line}|`);
      }
      view.unmount();
    }
    // Context panel (the /context screen).
    const ctxData = {
      ctxPct: 0.24,
      ctxTokens: 48_000,
      ctxMaxTokens: 200_000,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      mode: 'default',
      uptime: '12m',
      cacheStats: { readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 },
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
    for (const columns of [80, 60] as const) {
      const view = renderRealTty(
        <ContextPanel data={ctxData as never} onClose={() => {}} />,
        { columns, rows: 40 },
      );
      await settle();
      out.push(`=== CONTEXT ${columns} cols ===`);
      for (const [i, line] of view.lines().entries()) {
        out.push(`${String(i).padStart(2)} [${String(displayWidth(line)).padStart(3)}] |${line}|`);
      }
      view.unmount();
    }
    mkdirSync(DUMP_DIR, { recursive: true });
    writeFileSync(join(DUMP_DIR, 'tui-dump2.txt'), out.join('\n'));
  });
});
