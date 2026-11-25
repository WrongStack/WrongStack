import { describe, expect, it } from 'vitest';
import { runBootAutoThin } from '../src/boot/boot-auto-thin.js';

describe('runBootAutoThin non-finite policy guard (F2223)', () => {
  it('falls back to 30 idleDays when config.idleDays is Infinity', async () => {
    const DAY_MS = 86_400_000;
    const now = 200 * DAY_MS;
    const bridge = new Map([
      [
        'stale_tool',
        {
          invocations: 1,
          failures: 0,
          durationMsTotal: 10,
          lastInvokedAt: 100 * DAY_MS,
          firstInvokedAt: 100 * DAY_MS,
        },
      ],
    ]);

    const result = await runBootAutoThin({
      toolRegistry: {
        thinUnderused: () => ({ thinned: [], skipped: [] }),
      } as unknown as Parameters<typeof runBootAutoThin>[0]['toolRegistry'],
      events: { emit: () => {} } as unknown as Parameters<typeof runBootAutoThin>[0]['events'],
      configStore: {
        get: () => ({}),
      } as unknown as Parameters<typeof runBootAutoThin>[0]['configStore'],
      config: {
        enabled: true,
        applyOnBoot: true,
        idleDays: Number.POSITIVE_INFINITY,
        minInvocations: 3,
      },
      bridge,
      now: () => now,
      dryRun: true,
    });

    expect(result.candidates.map((c) => c.name)).toEqual(['stale_tool']);
  });
});
