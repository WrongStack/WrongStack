/**
 * `/openai-quota` renders whatever the Codex transport last observed, and says
 * something useful when it has observed nothing yet — which is the state every
 * session starts in, since the reading only arrives on a real response.
 */

import { recordProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOpenAIQuotaCommand } from '../src/slash-commands/openai-quota.js';

afterEach(() => {
  resetProviderQuota();
});

async function render(): Promise<string> {
  const result = await buildOpenAIQuotaCommand().run('');
  return (result as { message: string }).message;
}

describe('/openai-quota', () => {
  it('is provider-scoped and claims no generic aliases', () => {
    const cmd = buildOpenAIQuotaCommand();
    expect(cmd.name).toBe('openai-quota');
    expect(cmd.aliases ?? []).toEqual([]);
  });

  it('explains how to get a reading when none has arrived', async () => {
    expect(await render()).toContain('No quota reading yet');
  });

  it('shows each window with its percentage and reset countdown', async () => {
    recordProviderQuota('openai-codex', [
      {
        providerId: 'openai-codex',
        meterId: 'codex',
        planLabel: 'pro',
        windows: [
          {
            id: 'primary',
            usedPercent: 51,
            windowMinutes: 300,
            resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600,
          },
          { id: 'secondary', usedPercent: 24, windowMinutes: 10080 },
        ],
        capturedAt: Date.now(),
      },
    ]);
    const out = await render();
    expect(out).toContain('5h');
    expect(out).toContain('51%');
    expect(out).toContain('49% left');
    expect(out).toContain('resets in 1h 59m');
    expect(out).toContain('7d');
    expect(out).toContain('plan: pro');
  });

  it('names the limit that was reached', async () => {
    recordProviderQuota('openai-codex', [
      {
        providerId: 'openai-codex',
        meterId: 'codex',
        windows: [{ id: 'primary', usedPercent: 100 }],
        reachedWindowId: 'primary',
        capturedAt: Date.now(),
      },
    ]);
    expect(await render()).toContain('limit reached: primary');
  });
});
