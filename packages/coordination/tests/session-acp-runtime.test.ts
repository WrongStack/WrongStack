import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { afterEach, expect, it } from 'vitest';
import {
  __resetAllSessionSubagentModelPlans,
  restoreSessionSubagentModelPlan,
  sessionAcpRuntime,
  setSessionAcpRuntime,
} from '../src/session-subagent-models.js';

afterEach(__resetAllSessionSubagentModelPlans);
it('journals isolated settings and restores the latest selection even without a lane plan', async () => {
  const events: SessionEvent[] = [];
  const ctx = {
    meta: {} as Record<string, unknown>,
    session: {
      id: 'first',
      append: async (event: SessionEvent) => {
        events.push(event);
      },
    },
  };
  await setSessionAcpRuntime(ctx, { fixture: { engine: 'fast' } });
  await setSessionAcpRuntime(ctx, { fixture: { engine: 'deep', thought: 'ultra' } });
  expect(sessionAcpRuntime('second')).toEqual({});
  const copy = sessionAcpRuntime('first');
  copy.fixture!.engine = 'mutated';
  expect(sessionAcpRuntime('first').fixture!.engine).toBe('deep');
  __resetAllSessionSubagentModelPlans();
  const resumed = {
    meta: {} as Record<string, unknown>,
    session: { id: 'first', append: async () => {} },
  };
  restoreSessionSubagentModelPlan(resumed, events);
  expect(resumed.meta['acpRuntime']).toEqual({ fixture: { engine: 'deep', thought: 'ultra' } });
  expect(sessionAcpRuntime('first')).toEqual(resumed.meta['acpRuntime']);
});
it('does not apply a selection when journaling fails', async () => {
  const ctx = {
    meta: {} as Record<string, unknown>,
    session: {
      id: 'first',
      append: async () => {
        throw Error('disk full');
      },
    },
  };
  await expect(setSessionAcpRuntime(ctx, { fixture: { thought: 'low' } })).rejects.toThrow(
    'disk full',
  );
  expect(ctx.meta).toEqual({});
  expect(sessionAcpRuntime('first')).toEqual({});
});
