import type { Config } from '@wrongstack/contracts/types/config/root';
import { FetchError } from '@wrongstack/contracts/types/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@wrongstack/core/registry';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import { registerJevTools } from '../../src/management/jev-registration.js';
import { createJevTool } from '../../../core/src/typesafe/jev-tool.js';
import {
  resetTypeSafeJudgesForTests,
  resolveTypeSafeJudge,
} from '../../../core/src/typesafe/judgments.js';
import { resolveTypeSafeAccount } from '../../../core/src/typesafe/resolve.js';
import {
  createTypeSafeRestGate,
  resetSharedTypeSafeRestGatesForTests,
} from '../../../core/src/typesafe/rest.js';
import {
  jevSettingsSnapshot,
  testJevConnection,
  validateJevSettingsPatch,
} from '../../../core/src/typesafe/settings.js';

const request = {
  state: { value: 2 },
  questions: { check: { type: 'noul' as const, instructions: 'Is value 2?' } },
};
const config = (enabled?: boolean): Config =>
  ({
    version: 1,
    typesafe: { apiKey: 'key', ...(enabled === undefined ? {} : { enabled }) },
  }) as Config;
const success = () =>
  new Response(
    JSON.stringify({ answers: { check: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1 } }),
  );
afterEach(() => {
  resetTypeSafeJudgesForTests();
  resetSharedTypeSafeRestGatesForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Jev opt-in and payment stop', () => {
  it.each([undefined, false])(
    'a saved key never activates Jev when enabled=%s',
    async (enabled) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const cfg = config(enabled);
      expect(resolveTypeSafeAccount({ config: cfg }).status).toBe('disabled');
      expect(resolveTypeSafeJudge({ config: cfg, feature: 'brain' })).toBeUndefined();
      expect(jevSettingsSnapshot(cfg).readiness.tool?.state).toBe('disabled');
      expect(jevSettingsSnapshot(cfg).keySource).toBe('config');
      await expect(testJevConnection(cfg)).rejects.toThrow('disabled');
      await expect(
        createJevTool(() => cfg).execute(request, {} as never, {
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('unavailable');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('environment keys and explicit consumer switches cannot override the master disable', () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'env-key');
    const cfg = {
      version: 1,
      typesafe: { enabled: false, judgments: { tool: true, brain: true } },
      skills: { suggest: { enabled: true } },
      fleet: { dispatch: { typesafeClassifier: true } },
    } as Config;
    expect(resolveTypeSafeAccount({ config: cfg }).status).toBe('disabled');
    expect(
      Object.values(jevSettingsSnapshot(cfg).readiness).every((v) => v.state === 'disabled'),
    ).toBe(true);
    expect(() => validateJevSettingsPatch({ enabled: 'false' })).toThrow();
  });

  it('removes discovery, blocks retained clients immediately and can be re-enabled without losing the key', async () => {
    const fetch = vi.fn(success);
    vi.stubGlobal('fetch', fetch);
    const bootConfig = config(true);
    const store = new DefaultConfigStore(bootConfig);
    const registry = new ToolRegistry();
    const stop = registerJevTools(registry, store);
    const held = resolveTypeSafeJudge({ config: bootConfig, feature: 'brain' })!;
    expect(registry.get('jev')).toBeDefined();
    store.update({ typesafe: { ...store.get().typesafe, enabled: false } });
    expect(registry.get('jev')).toBeUndefined();
    expect(registry.get('jev_status')).toBeDefined();
    await expect(held.client.systemOne(request)).rejects.toThrow('disabled');
    expect(fetch).not.toHaveBeenCalled();
    store.update({ typesafe: { ...store.get().typesafe, enabled: true } });
    expect(store.get().typesafe?.apiKey).toBe('key');
    await expect(held.client.systemOne(request)).resolves.toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
  });

  it('cancels an in-flight request when its owning store disables Jev', async () => {
    const fetch = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const store = new DefaultConfigStore(config(true));
    const judge = resolveTypeSafeJudge({ config: store.get(), feature: 'brain' })!;
    const result = judge.client.systemOne(request);
    const rejected = expect(result).rejects.toThrow();
    store.update({ typesafe: { ...store.get().typesafe, enabled: false } });
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('one 402 stops other features, fresh account clients and even repeated diagnostic calls', async () => {
    const fetch = vi.fn(() => new Response('{}', { status: 402 }));
    vi.stubGlobal('fetch', fetch);
    const cfg = config(true);
    const brain = resolveTypeSafeJudge({ config: cfg, feature: 'brain' })!;
    await expect(brain.client.systemOne(request)).rejects.toThrow('402');
    const tool = resolveTypeSafeJudge({ config: cfg, feature: 'tool' })!;
    expect(tool.unavailableReason).toBe('payment-required');
    await expect(tool.client.systemOne(request)).rejects.toThrow();
    const fresh = resolveTypeSafeAccount({ config: cfg });
    if (fresh.status !== 'ready') throw new Error('missing account');
    await expect(fresh.client.systemOne(request)).rejects.toThrow('payment required');
    expect(jevSettingsSnapshot(cfg).reason).toContain('402');
    expect(fetch).toHaveBeenCalledTimes(1);
    const probe = resolveTypeSafeAccount({ config: cfg, restGate: null });
    if (probe.status !== 'ready') throw new Error('missing probe');
    await expect(probe.client.systemOne(request)).rejects.toThrow('402');
    await expect(probe.client.systemOne(request)).rejects.toThrow('payment required');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a different store using the same credential keeps its own master permission', async () => {
    const fetch = vi.fn(success);
    vi.stubGlobal('fetch', fetch);
    const a = new DefaultConfigStore(config(true));
    const b = new DefaultConfigStore(config(true));
    const first = resolveTypeSafeJudge({ config: a.get(), feature: 'brain' })!;
    const second = resolveTypeSafeJudge({ config: b.get(), feature: 'brain' })!;
    a.update({ typesafe: { ...a.get().typesafe, enabled: false } });
    await expect(first.client.systemOne(request)).rejects.toThrow('disabled');
    await expect(second.client.systemOne(request)).resolves.toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('payment rejection survives cooldowns and concurrent successful responses', () => {
    let now = 0;
    const gate = createTypeSafeRestGate({ now: () => now });
    expect(gate.recordFailure(new FetchError({ message: 'billing', status: 402 }))).toBe(true);
    now += 24 * 60 * 60 * 1000;
    gate.recordSuccess();
    expect(gate.recordFailure(new FetchError({ message: 'late failure', status: 503 }))).toBe(
      false,
    );
    expect(gate.isResting()).toBe(true);
    expect(gate.reason()).toContain('402');
    expect(gate.recordFailure(new FetchError({ message: 'billing', status: 402 }))).toBe(false);
  });

  it('reports concurrent payment rejections only once per client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response('{}', { status: 402 })),
    );
    const onDisabled = vi.fn();
    const account = resolveTypeSafeAccount({ config: config(true), onDisabled, restGate: null });
    if (account.status !== 'ready') throw new Error('missing account');
    await Promise.allSettled([
      account.client.systemOne(request),
      account.client.systemOne(request),
    ]);
    expect(onDisabled).toHaveBeenCalledTimes(1);
  });
});
