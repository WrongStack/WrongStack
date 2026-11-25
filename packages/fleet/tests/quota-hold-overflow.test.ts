import { describe, expect, it } from 'vitest';
import { runWithQuotaHold } from '../src/acp-quota-hold.js';

describe('runWithQuotaHold backoff cap', () => {
  it('caps extreme backoffMs values so hold timestamps never overflow to Invalid Date', async () => {
    const agentId = `vitest-agent-${Date.now()}-${Math.random()}`;
    await expect(
      runWithQuotaHold(
        agentId,
        async () => {
          throw {
            kind: 'provider_quota',
            message: 'quota exceeded',
            backoffMs: Number.MAX_VALUE,
          };
        },
        () => 1_700_000_000_000,
      ),
    ).rejects.toBeDefined();

    let msg = '';
    try {
      await runWithQuotaHold(
        agentId,
        async () => 'ok',
        () => 1_700_000_000_000 + 1000,
      );
    } catch (err) {
      msg = (err as { message?: string }).message ?? '';
    }
    expect(msg).toContain('held until');
    expect(msg).not.toContain('Invalid Date');
  });
});
