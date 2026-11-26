import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatchLogPath } from '@wrongstack/agent-catalog';
import { describe, expect, it } from 'vitest';
import { createDispatchOutcomeRecorder } from '../src/host-dispatch-outcomes.js';

describe('createDispatchOutcomeRecorder non-finite cost guard', () => {
  it('does not poison worker.costSeen when a task reports NaN cost', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-f2037-test-'));
    try {
      const listeners: Array<(e: unknown) => void> = [];
      const events = {
        on: (_ev: string, fn: (e: unknown) => void) => {
          listeners.push(fn);
          return () => {};
        },
      } as Parameters<typeof createDispatchOutcomeRecorder>[0]['events'];

      let currentCost = Number.NaN;
      const recorder = createDispatchOutcomeRecorder({
        events,
        director: () =>
          ({
            usage: { snapshot: () => ({ perSubagent: { s1: { cost: currentCost } } }) },
            resolvedModelFor: () => undefined,
          }) as unknown as ReturnType<
            Parameters<typeof createDispatchOutcomeRecorder>[0]['director']
          >,
        projectRoot: dir,
      });

      recorder.onSpawnRouted({
        at: new Date().toISOString(),
        subagentId: 's1',
        role: 'coder',
        provider: 'p',
        model: 'm',
        reason: 'r',
      } as unknown as Parameters<typeof recorder.onSpawnRouted>[0]);

      for (const fn of listeners) fn({ subagentId: 's1', status: 'success', durationMs: 100 });
      currentCost = 1.5;
      for (const fn of listeners) fn({ subagentId: 's1', status: 'success', durationMs: 100 });

      const lines = readFileSync(dispatchLogPath(dir), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind?: string; costUsd?: number });
      const outcomes = lines.filter((l) => l.kind === 'outcome');
      expect(outcomes).toHaveLength(2);
      expect(outcomes[1]?.costUsd).toBe(1.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
