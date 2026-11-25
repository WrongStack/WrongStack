import type { TrustBoundary } from '@wrongstack/core/security';
import { describe, expect, it } from 'vitest';
import { createAutoHealer } from '../src/server/connections/auto-healer.js';

const allowBoundary: TrustBoundary = {
  evaluate: async () => ({ kind: 'allow', reason: 'test' }),
} as unknown as TrustBoundary;

describe('createAutoHealer NaN option guards (F1843)', () => {
  it('falls back to safe defaults when maxAttempts, cooldownMs, or intervalMs are NaN', async () => {
    const errorReport = {
      services: [
        {
          id: 'kanban' as const,
          label: 'Kanban',
          status: 'error' as const,
          required: false,
          mode: 'ipc',
          control: 'restart' as const,
        },
      ],
    };

    let restarts = 0;
    const healer = createAutoHealer({
      projectRoot: () => '/tmp/p',
      indexDir: () => undefined,
      trustBoundary: allowBoundary,
      enabled: true,
      intervalMs: Number.NaN,
      cooldownMs: 0,
      maxAttempts: Number.NaN,
      collect: async () => errorReport as never,
      execute: async () => {
        restarts++;
        return { ok: false, message: 'still broken' } as never;
      },
    });
    for (let i = 0; i < 5; i++) await healer.tick();
    await healer.dispose();
    expect(restarts).toBe(3);

    let coolRestarts = 0;
    const cooled = createAutoHealer({
      projectRoot: () => '/tmp/p',
      indexDir: () => undefined,
      trustBoundary: allowBoundary,
      enabled: true,
      cooldownMs: Number.NaN,
      maxAttempts: 3,
      collect: async () => errorReport as never,
      execute: async () => {
        coolRestarts++;
        return { ok: false, message: 'still broken' } as never;
      },
    });
    await cooled.tick();
    await cooled.tick();
    await cooled.dispose();
    expect(coolRestarts).toBe(1);
  });
});
