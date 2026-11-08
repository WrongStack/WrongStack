import { EventBus } from '@wrongstack/contracts/kernel';
import { fleetBudgetFromDirector } from '@wrongstack/coordination';
import { describe, expect, it } from 'vitest';
import { installFleetConcurrencyFrames } from '../src/server/fleet-concurrency.js';

const director = (overrides: Record<string, unknown> = {}) => ({
  maxSpawns: 10,
  spawnCount: 3,
  status: () => ({
    subagents: [{ status: 'running' }, { status: 'idle' }, { status: 'completed' }],
  }),
  ...overrides,
});

describe('fleet budget', () => {
  it('reads the director: running and idle workers are active, spawns left of the budget', () => {
    expect(fleetBudgetFromDirector(director())).toEqual({
      maxSpawns: 10,
      usedSpawns: 3,
      remainingSpawns: 7,
      activeAgents: 2,
    });
    expect(fleetBudgetFromDirector(null)).toBeNull();
  });

  it("prefers the fleet manager's snapshot, with a restored checkpoint's ceiling", () => {
    expect(
      fleetBudgetFromDirector(
        director({
          fleetManager: {
            budgetSnapshot: () => ({
              maxSpawns: 20,
              usedSpawns: 5,
              remainingSpawns: 15,
              checkpointMaxSpawns: 12,
              ceilingMismatch: true,
            }),
          },
        }),
      ),
    ).toEqual({
      maxSpawns: 20,
      usedSpawns: 5,
      remainingSpawns: 15,
      activeAgents: 2,
      checkpointMaxSpawns: 12,
      ceilingMismatch: true,
    });
  });
});

describe('fleet.concurrency_update frames', () => {
  it('sends the gauge at once and on every ceiling change, spawn and completion', () => {
    const events = new EventBus();
    const sent: Array<Record<string, unknown>> = [];
    const frames = installFleetConcurrencyFrames({
      events,
      broadcast: (message) => sent.push(message.payload),
    });
    events.emit('subagent.spawned', { subagentId: 'w1' } as never);
    events.emit('concurrency.changed', { n: 6 } as never);
    events.emit('subagent.task_completed', { subagentId: 'w1' } as never);
    expect(sent).toEqual([
      { fleetConcurrency: 0, fleetConcurrencyMax: 4 },
      { fleetConcurrency: 1, fleetConcurrencyMax: 4 },
      { fleetConcurrency: 1, fleetConcurrencyMax: 6 },
      { fleetConcurrency: 0, fleetConcurrencyMax: 6 },
    ]);
    frames.dispose();
    events.emit('subagent.spawned', { subagentId: 'w2' } as never);
    expect(sent).toHaveLength(4);
  });

  it('carries the director budget when the host has one', () => {
    const sent: Array<Record<string, unknown>> = [];
    installFleetConcurrencyFrames({
      events: new EventBus(),
      broadcast: (message) => sent.push(message.payload),
      getBudget: () => fleetBudgetFromDirector(director()),
    });
    expect(sent[0]).toMatchObject({
      fleetConcurrency: 2,
      maxSpawns: 10,
      usedSpawns: 3,
      remainingSpawns: 7,
    });
  });
});
