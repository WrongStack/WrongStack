import { describe, expect, it } from 'vitest';
import type { QuotaSnapshot } from '../src/providers/provider-quota-store';
import { providerQuotaStatus } from '../src/providers/switcher-status';

function meter(patch: Partial<QuotaSnapshot> & { providerId: string }): QuotaSnapshot {
  return { meterId: 'default', windows: [], capturedAt: 1_800_000_000_000, ...patch };
}

describe('providerQuotaStatus', () => {
  it('reports the busiest window as a quota bar', () => {
    expect(
      providerQuotaStatus('openai-codex', [
        meter({
          providerId: 'openai-codex',
          windows: [
            { id: 'primary', usedPercent: 12, windowMinutes: 300 },
            { id: 'secondary', usedPercent: 84, windowMinutes: 10_080 },
          ],
        }),
      ]),
    ).toEqual({ kind: 'quota', left: 16, window: '7d', level: 'warn', resetsAt: undefined });
  });

  it('leaves a gateway pool account out, so one exhausted account does not cut the session off', () => {
    expect(
      providerQuotaStatus('omniroute', [
        meter({
          providerId: 'omniroute',
          via: 'omniroute',
          reachedWindowId: 'primary',
          windows: [{ id: 'primary', usedPercent: 100, windowMinutes: 300 }],
        }),
      ]),
    ).toEqual({ kind: 'none' });
  });

  it('reports "reached" for a cut-off meter that carries no window readings', () => {
    // `parseAnthropicRateLimitHeaders` returns this shape on a 429 whose
    // utilization headers were dropped: the id is all it knows.
    expect(
      providerQuotaStatus('anthropic-oauth', [
        meter({ providerId: 'anthropic-oauth', windows: [], reachedWindowId: '7d' }),
      ]),
    ).toEqual({ kind: 'reached', window: '7d', resetsAt: undefined });
  });

  it('lets the cut-off window win over a busier one', () => {
    expect(
      providerQuotaStatus('anthropic-oauth', [
        meter({
          providerId: 'anthropic-oauth',
          reachedWindowId: '5h',
          windows: [
            { id: '5h', usedPercent: 30, windowMinutes: 300, resetsAt: 1_800_000_600 },
            { id: '7d', usedPercent: 90, windowMinutes: 10_080, resetsAt: 1_800_600_000 },
          ],
        }),
      ]),
    ).toEqual({ kind: 'reached', window: '5h', resetsAt: 1_800_000_600 });
  });
});
