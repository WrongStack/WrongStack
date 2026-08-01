import { describe, expect, it } from 'vitest';
import {
  resolveAllPendingConfirms,
  resolveYoloEligiblePendingConfirms,
  type PendingConfirm,
} from '@wrongstack/webui-server';

describe('pending confirm resolution', () => {
  // WS-022 (inverted): this asserted that flipping YOLO on blanket-answered
  // "yes" to EVERY prompt already on screen, destructive ones included — a
  // prompt the user had deliberately not answered yet. The fixture even builds
  // one tagged `riskTier: 'destructive'` and expected it approved. YOLO is a
  // forward-looking mode; it must not retroactively consent to a pending
  // destructive action. This file lives under `packages/webui/**`, which the
  // root vitest suite excludes, which is why the pin survived so long.
  it('auto-approves standard pending confirms but leaves destructive ones pending', () => {
    const pending = new Map<string, PendingConfirm>();
    const decisions: string[] = [];
    pending.set('safe', {
      resolve: (decision) => decisions.push(`safe:${decision}`),
      riskTier: 'standard',
    });
    pending.set('destructive', {
      resolve: (decision) => decisions.push(`destructive:${decision}`),
      decisionSource: 'yolo_destructive',
      riskTier: 'destructive',
    });

    resolveYoloEligiblePendingConfirms(pending);

    expect(decisions).toEqual(['safe:yes']);
    expect(pending.has('safe')).toBe(false);
    // Still on screen, still the user's call.
    expect(pending.has('destructive')).toBe(true);
  });

  it('resolves every pending confirm with the provided decision', () => {
    const pending = new Map<string, PendingConfirm>();
    const decisions: string[] = [];
    pending.set('one', { resolve: (decision) => decisions.push(`one:${decision}`) });
    pending.set('two', { resolve: (decision) => decisions.push(`two:${decision}`) });

    resolveAllPendingConfirms(pending, 'no');

    expect(decisions).toEqual(['one:no', 'two:no']);
    expect(pending.size).toBe(0);
  });
});
