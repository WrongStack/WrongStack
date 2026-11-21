import type { AcpSteerOutcome } from '@wrongstack/acp';
import type { SubagentError, SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { registerAcpSteerInbox } from '../src/acp-live-steer.js';
import { runWithQuotaHold } from '../src/acp-quota-hold.js';

describe('fleet ACP steer lifecycle and quota-hold monotonicity', () => {
  it('suppresses late onUndelivered callbacks after unregister()', async () => {
    let resolveSteer!: (v: AcpSteerOutcome) => void;
    const steerPromise = new Promise<AcpSteerOutcome>((r) => {
      resolveSteer = r;
    });
    const undelivered: string[] = [];
    let deliverFn: ((note: { from: string; kind: string; body: string }) => void) | undefined;

    const unregister = registerAcpSteerInbox(
      {
        sessionId: 'sess-steer-audit',
        subagentId: 'claude-audit',
        config: { name: 'Claude' },
      } as unknown as SubagentRunContext,
      {} as TaskSpec,
      () => steerPromise,
      {
        register: (entry) => {
          deliverFn = entry.deliver as typeof deliverFn;
          return () => {};
        },
      },
      (outcome) => undelivered.push(outcome),
    );

    deliverFn?.({ from: 'leader', kind: 'note', body: 'late' });
    unregister?.();
    resolveSteer('promptRequired');
    await Promise.resolve();
    await Promise.resolve();

    expect(undelivered).toEqual([]);
  });

  it('does not let a concurrent shorter quota failure shorten an existing longer hold', async () => {
    let clock = 90_000_000;
    const now = () => clock;
    let rejectA!: (e: unknown) => void;
    let rejectB!: (e: unknown) => void;
    const pA = runWithQuotaHold(
      'agent-quota-monotonic-audit',
      () => new Promise<string>((_r, j) => (rejectA = j)),
      now,
    );
    const pB = runWithQuotaHold(
      'agent-quota-monotonic-audit',
      () => new Promise<string>((_r, j) => (rejectB = j)),
      now,
    );

    const quotaErr = (backoffMs: number): SubagentError => ({
      kind: 'provider_quota',
      message: 'quota exceeded',
      retryable: false,
      backoffMs,
    });

    rejectA(quotaErr(60 * 60_000));
    await expect(pA).rejects.toMatchObject({ kind: 'provider_quota' });
    rejectB(quotaErr(60_000));
    await expect(pB).rejects.toMatchObject({ kind: 'provider_quota' });

    clock += 5 * 60_000;
    let ran = false;
    await expect(
      runWithQuotaHold(
        'agent-quota-monotonic-audit',
        async () => {
          ran = true;
          return 'ok';
        },
        now,
      ),
    ).rejects.toMatchObject({ kind: 'provider_quota' });
    expect(ran).toBe(false);
  });
});
