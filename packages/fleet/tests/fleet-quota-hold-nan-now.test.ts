import { describe, expect, it } from 'vitest';
import { runWithQuotaHold } from '../src/acp-quota-hold.js';

describe('runWithQuotaHold non-finite now() guard (F2240)', () => {
  it('retains active quota hold instead of deleting it when now() returns NaN', async () => {
    const agentId = 'quota-hold-nan-now-vitest-agent';
    await expect(
      runWithQuotaHold(
        agentId,
        async () => {
          throw { kind: 'provider_quota', message: 'Quota exceeded', backoffMs: 60_000 };
        },
        () => Date.now(),
      ),
    ).rejects.toMatchObject({ kind: 'provider_quota' });

    let started = false;
    await expect(
      runWithQuotaHold(
        agentId,
        async () => {
          started = true;
          return 'ran';
        },
        () => Number.NaN,
      ),
    ).rejects.toMatchObject({ kind: 'provider_quota' });
    expect(started).toBe(false);
  });
});
