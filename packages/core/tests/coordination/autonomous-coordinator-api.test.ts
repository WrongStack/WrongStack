/**
 * Additional coverage for autonomous-coordinator.ts — public API methods
 * (getStats, stop, createGoal, dispose) with minimal mock setup.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutonomousCoordinator } from '../../src/coordination/autonomous-coordinator.js';
import type { AutonomousCoordinatorOptions } from '../../src/coordination/autonomous-coordinator.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = path.join(
    os.tmpdir(),
    `wstack-coord-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EPERM' && code !== 'EBUSY') throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
});

function makeCoordinator(
  overrides: Partial<AutonomousCoordinatorOptions> = {},
): AutonomousCoordinator {
  return new AutonomousCoordinator({
    selfAgentId: 'test-agent',
    selfAgentName: 'test-agent',
    sessionDir: tempDir,
    llmProvider: { decide: vi.fn(async () => ({ optionId: 'a', rationale: 'test' })) },
    ...overrides,
  });
}

describe('AutonomousCoordinator — public API', () => {
  it('creates a coordinator with default state', () => {
    const coord = makeCoordinator();
    expect(coord).toBeDefined();
    expect(coord.graph).toBeDefined();
    expect(coord.dag).toBeDefined();
    expect(coord.auction).toBeDefined();
    expect(coord.consensus).toBeDefined();
    expect(coord.changes).toBeDefined();
    expect(coord.brain).toBeDefined();
  });

  it('getStats returns initial statistics', () => {
    const coord = makeCoordinator();
    const stats = coord.getStats();
    expect(stats).toBeDefined();
    expect(stats.goals.total).toBe(0);
    expect(stats.goals.progress).toBe(0);
  });

  it('stop is safe to call when not running', () => {
    const coord = makeCoordinator();
    coord.stop(); // synchronous, no-op when not running
    const stats = coord.getStats();
    expect(stats.goals.total).toBe(0);
  });

  it('stop is idempotent', () => {
    const coord = makeCoordinator();
    coord.stop();
    coord.stop();
    expect(coord.getStats().goals.total).toBe(0);
  });

  it('createGoal adds a goal to the knowledge graph', async () => {
    const coord = makeCoordinator();
    const goal = await coord.createGoal({
      title: 'Test goal',
      description: 'A test goal for coverage',
    });
    expect(goal).toBeDefined();
    expect(goal.id).toBeDefined();
    expect(goal.title).toBe('Test goal');
  });

  it('createGoal with priority and tags', async () => {
    const coord = makeCoordinator();
    const goal = await coord.createGoal({
      title: 'Tagged goal',
      description: 'Goal with metadata',
      priority: 'high',
      tags: ['test', 'coverage'],
    });
    expect(goal.title).toBe('Tagged goal');
    expect(goal.priority).toBe('high');
    expect(goal.tags).toContain('test');
  });

  it('emits coordinator events when callback is provided', async () => {
    const events: unknown[] = [];
    const coord = makeCoordinator({
      onCoordinatorEvent: (e) => events.push(e),
    });
    await coord.createGoal({
      title: 'Event goal',
      description: 'Should emit event',
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it('dispose cleans up subscriptions', () => {
    const coord = makeCoordinator();
    coord.createGoal({ title: 'Cleanup goal', description: 'test' });
    // dispose should not throw
    coord.dispose();
  });
});
