/**
 * Regressions for the fallback subsystem's "never engaged when it should have"
 * failures. Each case here is a path that previously either threw instead of
 * hopping, or silently resolved to a different model than the one configured.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createFallbackModelExtension,
  runtimeFallbackChain,
} from '../../src/core/fallback-model.js';
import { FallbackProfileManager } from '../../src/core/fallback-profile-manager.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Config } from '../../src/types/config.js';
import { ProviderError } from '../../src/types/provider.js';

// Deliberately `Record<string, unknown>` and not `Partial<Config>`: several
// cases below inject values the config type forbids (`null`, `0`,
// `'not-an-array'`) to prove the resolver treats them as "unset" rather than
// throwing. Narrowing this would make those regressions unwritable.
function cfg(over: Record<string, unknown> = {}): Config {
  return {
    version: 1,
    provider: 'p1',
    model: 'm1',
    providers: {
      p1: { type: 'openai', apiKey: 'k1', models: ['m1', 'm1b'] },
      p2: { type: 'openai', apiKey: 'k2', models: ['m2'] },
    },
    ...over,
  } as unknown as Config;
}

const fakeProvider = (id: string) => ({ id, capabilities: { maxContext: 200_000 } }) as never;

describe('routing fields cleared by the config watcher', () => {
  // The hot-reload watcher clears a field no config layer defines. It used to
  // write `null`, and the resolver's `!== undefined` check walked into
  // `null.length` — inside the chain builder, so the TypeError replaced the
  // 429 and nothing was ever tried. Any non-array must read as "not set".
  for (const cleared of [null, undefined, 'not-an-array', 0] as const) {
    it(`treats fallbackModels=${JSON.stringify(cleared)} as unset instead of throwing`, () => {
      const mgr = new FallbackProfileManager(cfg({ fallbackModels: cleared }));
      const chain = mgr.resolveCandidates({ providerId: 'p1', model: 'm1' }, {});
      expect(chain.map((e) => `${e.providerId}/${e.model}`)).toContain('p2/m2');
    });
  }

  it('still hops on a 429 with every routing field cleared to null', async () => {
    const config = cfg({
      fallbackModels: null,
      fallbackAuto: null,
      fallbackProfiles: null,
      fallbackProfile: null,
      favoriteModels: null,
      fallbackBridge: null,
      modelAvailabilitySchedule: null,
    });
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider: (id) => fakeProvider(id),
      events: new EventBus(),
    });
    const ctx = {
      provider: fakeProvider('p1'),
      model: 'm1',
      activeRunSessionId: '2026-08-26/sess_01TESTFALLBACKRESILIENCE0',
    } as never as {
      provider: { id: string };
      model: string;
    };
    let calls = 0;
    const inner = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new ProviderError('rate limited', 429, true, 'p1', { kind: 'rate_limit' });
      }
      return { content: [{ type: 'text', text: 'ok' }] } as never;
    });
    const wrap = ext.wrapProviderRunner as any;
    // Previously this rejected with "Cannot read properties of null (reading
    // 'length')" — the 429 never even reached the chain.
    await expect(wrap(ctx, { model: 'm1' }, inner)).resolves.toBeDefined();
    expect(inner).toHaveBeenCalledTimes(2);
    expect(ctx.model).not.toBe('m1');
  });
});

describe('named profile selection', () => {
  const withProfiles = (over: Record<string, unknown> = {}) =>
    cfg({
      fallbackProfiles: { strong: ['p2/m2'], weak: ['p1/m1b'] },
      ...over,
    });

  it('drives failover from config.fallbackProfile without any caller passing it', () => {
    // The leader wires no `getFallbackProfile`, so before `fallbackProfile`
    // existed a named profile could only take effect by being copied over
    // `fallbackModels` — profiles were unreachable for the leader.
    const mgr = new FallbackProfileManager(withProfiles({ fallbackProfile: 'strong' }));
    expect(
      mgr.resolveCandidates({ providerId: 'p1', model: 'm1' }, {}).map((e) => e.model),
    ).toEqual(['m2']);
  });

  it('lets an explicit chain win over the selected profile', () => {
    const mgr = new FallbackProfileManager(
      withProfiles({ fallbackProfile: 'strong', fallbackModels: ['p1/m1b'], fallbackAuto: false }),
    );
    expect(
      mgr.resolveCandidates({ providerId: 'p1', model: 'm1' }, {}).map((e) => e.model),
    ).toEqual(['m1b']);
  });

  it('ignores a selection naming a profile that no longer exists', () => {
    const mgr = new FallbackProfileManager(withProfiles({ fallbackProfile: 'deleted' }));
    expect(mgr.activeProfileName()).toBeUndefined();
    expect(mgr.resolveCandidates({ providerId: 'p1', model: 'm1' }, {}).length).toBeGreaterThan(0);
  });

  it('lets an explicit caller profile override the selected one', () => {
    const mgr = new FallbackProfileManager(withProfiles({ fallbackProfile: 'strong' }));
    expect(
      mgr
        .resolveCandidates({ providerId: 'p1', model: 'm1' }, { fallbackProfile: 'weak' })
        .map((e) => e.model),
    ).toEqual(['m1b']);
  });
});

describe('profile / explicit-chain filter parity', () => {
  it('resolves a stale-model-list ref identically on both paths', () => {
    // `providers[].models` drifts (re-auth rewrites it). Filtering profiles on
    // it — while never filtering the explicit chain — silently rerouted every
    // role pinned to that profile onto the next entry.
    const config = cfg({
      providers: { p1: { type: 'openai', apiKey: 'k1', models: ['m1'] } },
      fallbackProfiles: { stale: ['p1/dropped-from-list'] },
    });
    const mgr = new FallbackProfileManager(config);
    expect(mgr.resolve('stale').map((e) => e.model)).toEqual(['dropped-from-list']);
    expect(mgr.resolveRefs(['p1/dropped-from-list']).map((e) => e.model)).toEqual([
      'dropped-from-list',
    ]);
  });
});

describe('runtimeFallbackChain', () => {
  it('reports the full order the loop will try, not just the explicit list', () => {
    const config = cfg({ fallbackModels: ['p2/m2'], fallbackBridge: 'p1/m1b' });
    // The bridge is tried before the explicit chain; the old `/fallback` view
    // rendered only the explicit list and so could not describe this.
    expect(runtimeFallbackChain(config)).toEqual(['p1/m1b', 'p2/m2']);
  });
});

describe('rate-limit retry vs failover', () => {
  const policy = new DefaultRetryPolicy();
  const rateLimited = (retryAfterMs?: number) =>
    new ProviderError('rate limited', 429, true, 'p1', {
      kind: 'rate_limit',
      ...(retryAfterMs !== undefined ? { body: { retryAfterMs } } : {}),
    });

  it('keeps retrying in place for a short Retry-After window', () => {
    expect(policy.shouldRetry(rateLimited(2_000), 0)).toBe(true);
    expect(policy.shouldRetry(rateLimited(), 0)).toBe(true);
  });

  it('fails over immediately when the provider asks for a long wait', () => {
    // 5 in-place attempts each honouring a hint clamped at 60s spent up to
    // ~5 minutes asleep before the fallback engine — which only runs after
    // retries are exhausted — got to try a healthy model.
    expect(policy.shouldRetry(rateLimited(60_000), 0)).toBe(false);
    expect(policy.shouldRetry(rateLimited(15_000), 0)).toBe(false);
  });
});

describe('live fallbackStickiness', () => {
  it('reads sticky-dwell from the config on every turn, not from boot', async () => {
    // Read once at construction, a stickiness edit needed a full restart even
    // though every other fallback input is recomputed per turn.
    let config = cfg({ fallbackStickiness: { stickyFallbackTurns: 0 } });
    const switched: string[] = [];
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider: (id) => fakeProvider(id),
      onModelSwitch: (id) => {
        switched.push(id);
      },
      events: new EventBus(),
    });
    const ctx = {
      provider: fakeProvider('p2'),
      model: 'm2',
      activeRunSessionId: '2026-08-26/sess_01TESTFALLBACKRESILIENCE0',
    } as never as {
      provider: { id: string };
      model: string;
    };
    // Force a hop so the extension is "dirty" and beforeRun starts probing.
    let calls = 0;
    await (ext.wrapProviderRunner as any)(
      {
        provider: fakeProvider('p1'),
        model: 'm1',
        activeRunSessionId: '2026-08-26/sess_01TESTFALLBACKRESILIENCE0',
      },
      { model: 'm1' },
      async () => {
        calls += 1;
        if (calls === 1)
          throw new ProviderError('overloaded', 529, true, 'p1', { kind: 'overloaded' });
        return { content: [{ type: 'text', text: 'ok' }] } as never;
      },
    );
    switched.length = 0;

    // Raise the dwell requirement AFTER construction — it must be honoured.
    config = cfg({ fallbackStickiness: { stickyFallbackTurns: 3, primaryProbeInterval: 0 } });
    await (ext.beforeRun as any)(ctx);
    expect(switched).toEqual([]);
  });
});
