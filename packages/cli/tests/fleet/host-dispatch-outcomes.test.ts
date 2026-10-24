import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { summarizeDispatchLog } from '@wrongstack/core/agent-catalog';
import type { Director } from '@wrongstack/core/coordination';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDispatchOutcomeRecorder } from '../../src/fleet/host-dispatch-outcomes.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-dispatch-outcomes-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function completed(events: EventBus, subagentId: string, status: 'success' | 'failed') {
  events.emit('subagent.task_completed', {
    subagentId,
    taskId: `${subagentId}-t`,
    status,
    iterations: 1,
    toolCalls: 1,
    durationMs: 1200,
  });
}

describe('dispatch outcome recorder', () => {
  it('records each task of a routed worker with its own spend and model', () => {
    const events = new EventBus();
    let cost = 0;
    const director = {
      usage: {
        snapshot: () => ({ perSubagent: { w1: { cost, provider: 'p', model: 'm' } } }),
      },
      resolvedModelFor: () => ({ provider: 'zai', model: 'glm' }),
    } as unknown as Director;
    const recorder = createDispatchOutcomeRecorder({
      events,
      director: () => director,
      projectRoot,
    });

    recorder.onSpawnRouted({
      at: '2026-10-20T10:00:00.000Z',
      role: 'test',
      source: 'description',
      method: 'heuristic',
      subagentId: 'w1',
    });
    cost = 0.4;
    completed(events, 'w1', 'success');
    cost = 1;
    completed(events, 'w1', 'failed');
    // A worker that never went through routing (a companion) is not graded.
    completed(events, 'companion-1', 'failed');
    recorder.dispose();
    completed(events, 'w1', 'success');

    const summary = summarizeDispatchLog(projectRoot);
    const test = summary.roles.find((row) => row.role === 'test');
    expect(summary.totals.outcomes).toBe(2);
    expect(test?.outcomes).toEqual({ success: 1, failed: 1, timeout: 0, stopped: 0 });
    // 0.4 for the first task, 0.6 for the second — not 0.4 + 1.0.
    expect(test?.costUsd).toBe(1);
    expect(test?.models).toEqual({ 'zai/glm': 2 });
    expect(summary.totals.outcomesByMethod.heuristic.success).toBe(1);
  });
});
