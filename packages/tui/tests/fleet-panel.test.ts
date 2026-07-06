import { describe, expect, it } from 'vitest';
import type { TodoItem } from '@wrongstack/core';
import type { FleetEntry } from '../src/app-reducer.js';
import {
  buildSwarmGrid,
  buildTodoPreviewRows,
  selectSwarmEntries,
  swarmColumnCount,
  swarmMeter,
  truncToWidth,
} from '../src/components/fleet-panel.js';

function entry(over: Partial<FleetEntry> & Pick<FleetEntry, 'id' | 'status'>): FleetEntry {
  const { id, status, ...rest } = over;
  return {
    id,
    name: id,
    status,
    streamingText: '',
    iterations: 0,
    toolCalls: 0,
    recentTools: [],
    recentMessages: [],
    cost: 0,
    startedAt: 0,
    lastEventAt: 0,
    ...rest,
  };
}

describe('FleetPanel swarm helpers', () => {
  it('truncates to the requested width without wrapping', () => {
    expect(truncToWidth('abcdef', 4)).toBe('abc…');
    expect(truncToWidth('abcdef', 1)).toBe('…');
    expect(truncToWidth('abc', 4)).toBe('abc');
  });

  it('chooses responsive columns capped for terminal readability', () => {
    expect(swarmColumnCount(40)).toBe(1);
    expect(swarmColumnCount(80)).toBe(2);
    expect(swarmColumnCount(160)).toBe(4);
    expect(swarmColumnCount(240)).toBe(5);
  });

  it('selects only active agents for the always-visible swarm', () => {
    const now = 200_000;
    const selected = selectSwarmEntries(
      {
        leader: entry({ id: 'leader', name: 'LEADER', status: 'running', startedAt: 1 }),
        done: entry({ id: 'done', status: 'success', lastEventAt: now - 10_000 }),
        stale: entry({ id: 'stale', status: 'failed', lastEventAt: now - 200_000 }),
        idle: entry({ id: 'idle', status: 'idle', startedAt: 2 }),
        run: entry({ id: 'run', status: 'running', startedAt: 3 }),
      },
      now,
      { includeLeader: false },
    );
    expect(selected.map((e) => e.id)).toEqual(['run']);
  });

  it('builds a bounded grid with an overflow cell', () => {
    const entries = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `a${i}`,
        entry({ id: `a${i}`, status: 'running', startedAt: i, toolCalls: i }),
      ]),
    );
    const grid = buildSwarmGrid(entries, 100_000, 80, { maxRows: 2 });
    expect(grid.columns).toBe(2);
    expect(grid.rows).toHaveLength(2);
    expect(grid.rows.flat()).toHaveLength(4);
    expect(grid.rows.flat().at(-1)).toMatchObject({ id: '__overflow' });
    expect(grid.overflow).toBe(5);
  });

  it('renders fixed-width meters per status', () => {
    expect(swarmMeter(entry({ id: 'idle', status: 'idle' }), 0, 6)).toBe('░░░░░░');
    expect(swarmMeter(entry({ id: 'ok', status: 'success' }), 0, 6)).toBe('██████');
    expect(swarmMeter(entry({ id: 'bad', status: 'failed' }), 0, 6)).toBe('■■■■■■');
    expect(swarmMeter(entry({ id: 'run', status: 'running' }), 3_000, 6)).toHaveLength(6);
    expect(swarmMeter(entry({ id: 'narrow', status: 'running' }), 3_000, 1)).toHaveLength(1);
  });
});

describe('FleetPanel todo preview', () => {
  it('orders in-progress before pending and completed', () => {
    const todos: TodoItem[] = [
      { id: 'done', content: 'ship it', status: 'completed' },
      { id: 'todo', content: 'write tests', status: 'pending' },
      { id: 'doing', content: 'implement panel', activeForm: 'implementing panel', status: 'in_progress' },
    ];
    const rows = buildTodoPreviewRows(todos, 50, 3);
    expect(rows.map((r) => r.id)).toEqual(['doing', 'todo', 'done']);
    expect(rows[0]).toMatchObject({ marker: '●', text: 'implementing panel' });
  });

  it('adds an overflow row when todos exceed the preview limit', () => {
    const todos: TodoItem[] = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`,
      content: `task ${i}`,
      status: 'pending',
    }));
    const rows = buildTodoPreviewRows(todos, 30, 5);
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toMatchObject({ id: '__todo_overflow', text: '2 more' });
  });
});
