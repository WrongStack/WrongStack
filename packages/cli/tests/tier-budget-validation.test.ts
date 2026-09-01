import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTierCommand } from '../src/slash-commands/tier.js';

interface TierLevelRecord {
  maxCostUsd?: number;
  maxIterations?: number;
  maxToolCalls?: number;
}

/**
 * `/tier budget` validation: a stored negative `maxIterations`/`maxToolCalls`
 * propagates through `resolveTier().budget` → `applyTierToSubagentConfig`
 * (`Math.min` tightening) into every agent spawned under the tier, where
 * `iterations >= maxIterations` is instantly true — zero-work agents from a
 * command that reported ✓. Negative and non-numeric values must therefore be
 * rejected exactly like a negative `maxCostUsd`.
 */
describe('tier command — /tier budget validation', () => {
  let dir: string;
  let cfg: Record<string, unknown>;

  const levels = (): Record<string, TierLevelRecord> =>
    ((cfg['modelTiers'] as { levels?: Record<string, TierLevelRecord> } | undefined)?.levels ?? {});

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tier-'));
    cfg = {
      provider: 'p',
      model: 'm',
      activeProfile: 'default',
      fallbackProfiles: {},
      modelTiers: { enabled: true, levels: {}, routing: {} },
    };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function command(): ReturnType<typeof buildTierCommand> {
    const ctx = {
      configStore: {
        get: () => cfg,
        update: (patch: Record<string, unknown>) => {
          Object.assign(cfg, patch);
        },
      },
      paths: { profileConfig: (name: string) => path.join(dir, `${name}.config.json`) },
    } as unknown as Parameters<typeof buildTierCommand>[0];
    return buildTierCommand(ctx);
  }

  it('rejects a negative maxIterations instead of storing poison', async () => {
    const res = (await command().run('budget premium 0.50 -5')) as { message?: string };
    expect(res?.message).toContain('Invalid maxIterations');
    expect(levels()['premium']?.maxIterations).toBeUndefined();
    expect(levels()['premium']?.maxCostUsd).toBeUndefined();
  });

  it('rejects a negative maxToolCalls instead of storing poison', async () => {
    const res = (await command().run('budget duo 0.50 40 -3')) as { message?: string };
    expect(res?.message).toContain('Invalid maxToolCalls');
    expect(levels()['duo']?.maxToolCalls).toBeUndefined();
  });

  it('rejects a non-numeric maxIterations instead of silently dropping it', async () => {
    const res = (await command().run('budget solo 0.25 five')) as { message?: string };
    expect(res?.message).toContain('Invalid maxIterations');
    expect(levels()['solo']?.maxIterations).toBeUndefined();
  });

  it('stores a fully valid budget', async () => {
    const res = (await command().run('budget std 0.25 40 120')) as { message?: string };
    expect(res?.message).toContain('✓');
    expect(levels()['std']).toMatchObject({
      maxCostUsd: 0.25,
      maxIterations: 40,
      maxToolCalls: 120,
    });
  });

  it('keeps the negative maxCostUsd rejection (existing behavior)', async () => {
    const res = (await command().run('budget negusd -0.25')) as { message?: string };
    expect(res?.message).toContain('Invalid maxCostUsd');
    expect(levels()['negusd']?.maxCostUsd).toBeUndefined();
  });
});
