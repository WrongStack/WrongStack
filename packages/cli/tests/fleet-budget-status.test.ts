import { describe, expect, it, vi } from 'vitest';
import {
  buildFleetHostStatus,
  type FleetBudgetView,
  formatFleetBudgetLines,
} from '../src/fleet/host-status.js';
import { buildFleetCommand } from '../src/slash-commands/fleet.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function fleetCtx(extra: object = {}): SlashCommandContext {
  return {
    session: { id: 's1' },
    renderer: { write: () => {}, writeWarning: () => {}, projectRoot: '/tmp' },
    projectRoot: '/tmp',
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    model: 'test',
    cwd: '/tmp',
    meta: {},
    state: {
      replaceMessages: () => {},
      replaceTodos: () => {},
      deleteMeta: () => {},
    },
    ...extra,
  } as never as SlashCommandContext;
}

describe('formatFleetBudgetLines', () => {
  it('renders concurrency and lifetime spawn budget', () => {
    const budget: FleetBudgetView = {
      maxConcurrent: 8,
      activeAgents: 3,
      maxSpawns: 256,
      usedSpawns: 103,
      remainingSpawns: 153,
      effectiveSource: 'maxConcurrent=profile, maxSpawns=profile',
    };
    const text = formatFleetBudgetLines(budget).join('\n');
    expect(text).toContain('maxConcurrent: 8');
    expect(text).toContain('activeAgents: 3');
    expect(text).toContain('maxSpawns: 256');
    expect(text).toContain('usedSpawns: 103');
    expect(text).toContain('remainingSpawns: 153');
    expect(text).toContain('source: maxConcurrent=profile, maxSpawns=profile');
  });

  it('warns when checkpoint ceiling disagrees with live', () => {
    const budget: FleetBudgetView = {
      maxConcurrent: 4,
      activeAgents: 0,
      maxSpawns: 256,
      usedSpawns: 48,
      remainingSpawns: 208,
      checkpointMaxSpawns: 96,
      ceilingMismatch: true,
    };
    const text = formatFleetBudgetLines(budget).join('\n');
    expect(text).toContain('checkpoint maxSpawns was 96');
    expect(text).toContain('live ceiling is 256');
  });
});

describe('buildFleetHostStatus budget', () => {
  it('includes budget when provided', () => {
    const status = buildFleetHostStatus({
      coordinatorStatus: null,
      fleetStatus: null,
      completedResults: null,
      shadowTaskIds: new Set(),
      budget: {
        maxConcurrent: 4,
        activeAgents: 0,
        maxSpawns: 64,
        usedSpawns: 12,
        remainingSpawns: 52,
      },
    });
    expect(status.budget?.maxSpawns).toBe(64);
    expect(status.budget?.usedSpawns).toBe(12);
  });
});

describe('/fleet status budget surface', () => {
  it('appends budget when onFleetStatus + onFleetBudget are wired', async () => {
    const writes: string[] = [];
    const onFleetStatus = vi.fn(() => ({
      coordinatorId: 'c1',
      subagents: [],
      pendingTasks: 0,
      completedTasks: 0,
      totalIterations: 0,
      done: false,
    }));
    const onFleetBudget = vi.fn(() => ({
      maxConcurrent: 8,
      activeAgents: 0,
      maxSpawns: 256,
      usedSpawns: 103,
      remainingSpawns: 153,
      checkpointMaxSpawns: 96,
      ceilingMismatch: true,
    }));
    const cmd = buildFleetCommand(
      fleetCtx({
        renderer: {
          write: (m: string) => writes.push(m),
          writeWarning: () => {},
          projectRoot: '/tmp',
        },
        onFleetStatus,
        onFleetBudget,
      }),
    );
    const res = await cmd.run('status', fleetCtx() as never);
    expect(res?.message).toContain('maxSpawns: 256');
    expect(res?.message).toContain('usedSpawns: 103');
    expect(res?.message).toContain('remainingSpawns: 153');
    expect(res?.message).toContain('checkpoint maxSpawns was 96');
    expect(onFleetBudget).toHaveBeenCalled();
  });
});
