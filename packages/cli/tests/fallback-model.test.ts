import { type Config, EventBus, type Provider, ProviderError } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createFallbackModelExtension,
  effectiveFallbackChain,
  parseModelRef,
  smartDefaultFallbackChain,
} from '../src/fallback-model.js';

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function fakeProvider(id: string): Provider {
  return { id, capabilities: {} as never, complete: vi.fn(), stream: vi.fn() } as Provider;
}

function makeCtx(providerId: string, model: string) {
  return { provider: fakeProvider(providerId), model } as never as import('@wrongstack/core').Context;
}

function overload(providerId: string) {
  return new ProviderError('overloaded', 529, true, providerId);
}

function cfg(over: Partial<Config>): Config {
  return { provider: 'anthropic', model: 'opus', fallbackModels: [], ...over } as never as Config;
}

describe('parseModelRef', () => {
  it('parses bare, slash, and space forms', () => {
    expect(parseModelRef('haiku')).toEqual({ model: 'haiku' });
    expect(parseModelRef('openai/gpt-x')).toEqual({ provider: 'openai', model: 'gpt-x' });
    expect(parseModelRef('openai gpt-x')).toEqual({ provider: 'openai', model: 'gpt-x' });
  });

  it('treats a leading-slash entry as "use the primary provider"', () => {
    expect(parseModelRef('/gpt-x')).toEqual({ provider: undefined, model: 'gpt-x' });
  });
});

describe('effectiveFallbackChain visibility filtering', () => {
  it('drops explicit fallback entries hidden by provider visibility lists', () => {
    expect(
      effectiveFallbackChain(cfg({
        provider: 'anthropic',
        model: 'opus',
        fallbackModels: ['planner', 'openai/gpt-x'],
        providers: {
          anthropic: { type: 'anthropic', models: ['haiku'] },
          openai: { type: 'openai', models: [] },
        },
      })),
    ).toEqual([]);
  });

  it('smart default only uses visible provider models', () => {
    expect(
      smartDefaultFallbackChain(cfg({
        provider: 'anthropic',
        model: 'opus',
        providers: {
          anthropic: { type: 'anthropic', apiKey: 'x', models: ['haiku'] },
          openai: { type: 'openai', apiKey: 'y', models: ['gpt-x'] },
        },
      })),
    ).toEqual(['anthropic/haiku', 'openai/gpt-x']);
  });
});

describe('createFallbackModelExtension', () => {
  it('always returns an extension; an empty chain is a no-op (rethrows)', async () => {
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: [] }),
      buildProvider: fakeProvider,
      events: new EventBus(),
      logger,
    });
    expect(ext).not.toBeNull();
    // No explicit chain and no smart-default-eligible providers → the wrapper
    // rethrows the original error without switching models.
    const ctx = makeCtx('anthropic', 'opus');
    const err = overload('anthropic');
    const inner = vi.fn(async () => {
      throw err;
    });
    await expect(
      ext.wrapProviderRunner!(ctx as never, { model: 'opus' } as never, inner as never),
    ).rejects.toBe(err);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('walks the chain on overload and succeeds on a fallback (same provider)', async () => {
    const events = new EventBus();
    const fired: unknown[] = [];
    events.on('provider.fallback', (p) => fired.push(p));
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['planner', 'haiku'] }),
      buildProvider: fakeProvider,
      events,
      logger,
    })!;

    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    const inner = vi.fn(async (_c: unknown, _r: unknown) => {
      call++;
      if (call <= 2) throw overload('anthropic'); // primary + first fallback fail
      return { stopReason: 'end_turn', usage: { input: 1, output: 1 } } as never;
    });

    const res = await ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never);
    expect(res).toBeTruthy();
    expect(call).toBe(3);
    expect(ctx.model).toBe('haiku');
    expect(fired).toHaveLength(2);
  });

  it('switches provider for a cross-provider entry', async () => {
    const events = new EventBus();
    const fired: { providerSwitched: boolean }[] = [];
    events.on('provider.fallback', (p) => fired.push(p as never));
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['openai/gpt-x'] }),
      buildProvider: fakeProvider,
      events,
      logger,
    })!;

    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    const inner = vi.fn(async () => {
      call++;
      if (call === 1) throw overload('anthropic');
      return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
    });

    await ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never);
    expect(ctx.provider.id).toBe('openai');
    expect(ctx.model).toBe('gpt-x');
    expect(fired[0]?.providerSwitched).toBe(true);
  });

  it('passes the fallback target model to buildProvider', async () => {
    const buildProvider = vi.fn((id: string) => fakeProvider(id));
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['openai/gpt-x'] }),
      buildProvider,
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    await ext.wrapProviderRunner!(
      ctx,
      { model: 'opus' } as never,
      (async () => {
        call++;
        if (call === 1) throw overload('anthropic');
        return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
      }) as never,
    );
    expect(buildProvider).toHaveBeenCalledWith('openai', 'gpt-x');
  });

  it('does not fall back on a non-overload error', async () => {
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['haiku'] }),
      buildProvider: fakeProvider,
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    const boom = new ProviderError('bad request', 400, false, 'anthropic');
    const inner = vi.fn(async () => {
      throw boom;
    });
    await expect(
      ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never),
    ).rejects.toBe(boom);
    expect(inner).toHaveBeenCalledTimes(1); // no chain walk
  });

  it('skips an entry whose provider cannot be built, continues the chain', async () => {
    const buildProvider = vi.fn((id: string) => {
      if (id === 'broken') throw new Error('no creds');
      return fakeProvider(id);
    });
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['broken/x', 'haiku'] }),
      buildProvider,
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    const inner = vi.fn(async () => {
      call++;
      if (call === 1) throw overload('anthropic');
      return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
    });
    await ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never);
    expect(ctx.model).toBe('haiku');
  });

  it('notifies onModelSwitch on fallback hop and on primary restore when cooldown is disabled', async () => {
    const switches: Array<[string, string]> = [];
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['openai/gpt-x'] }),
      buildProvider: fakeProvider,
      primaryCooldownMs: 0,
      onModelSwitch: (p, m) => {
        switches.push([p, m]);
      },
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    await ext.wrapProviderRunner!(
      ctx,
      { model: 'opus' } as never,
      (async () => {
        call++;
        if (call === 1) throw overload('anthropic');
        return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
      }) as never,
    );
    expect(switches).toContainEqual(['openai', 'gpt-x']); // fallback hop
    await ext.beforeRun!(ctx, {} as never);
    expect(switches).toContainEqual(['anthropic', 'opus']); // primary restore
  });

  it('waits for async onModelSwitch before retrying on the fallback model', async () => {
    const order: string[] = [];
    let releaseSwitch!: () => void;
    const switchGate = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['openai/gpt-x'] }),
      buildProvider: fakeProvider,
      onModelSwitch: async () => {
        order.push('switch-start');
        await switchGate;
        order.push('switch-done');
      },
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    const inner = vi.fn(async () => {
      call++;
      order.push(`inner-${call}`);
      if (call === 1) throw overload('anthropic');
      return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
    });

    const run = ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never);
    for (let i = 0; i < 5 && !order.includes('switch-start'); i++) {
      await Promise.resolve();
    }
    expect(order).toEqual(['inner-1', 'switch-start']);
    expect(inner).toHaveBeenCalledTimes(1);

    releaseSwitch();
    await run;

    expect(order).toEqual(['inner-1', 'switch-start', 'switch-done', 'inner-2']);
  });

  it('keeps the fallback during primary cooldown, then probes the primary', async () => {
    let t = 0;
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['haiku'] }),
      buildProvider: fakeProvider,
      primaryCooldownMs: 1000,
      now: () => t,
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');
    // Force a fallback so ctx lands on haiku.
    let call = 0;
    await ext.wrapProviderRunner!(
      ctx,
      { model: 'opus' } as never,
      (async () => {
        call++;
        if (call === 1) throw overload('anthropic');
        return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
      }) as never,
    );
    expect(ctx.model).toBe('haiku');
    // Next turn during cooldown: stay on the working fallback.
    await ext.beforeRun!(ctx, {} as never);
    expect(ctx.model).toBe('haiku');
    t = 1000;
    // Cooldown elapsed: beforeRun restores the configured primary as a probe.
    await ext.beforeRun!(ctx, {} as never);
    expect(ctx.model).toBe('opus');
    expect(ctx.provider.id).toBe('anthropic');
  });

  it('increases the primary cooldown after repeated failed probes', async () => {
    let t = 0;
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['haiku'] }),
      buildProvider: fakeProvider,
      primaryCooldownMs: 100,
      primaryCooldownMaxMs: 1000,
      now: () => t,
      events: new EventBus(),
      logger,
    })!;
    const ctx = makeCtx('anthropic', 'opus');

    let call = 0;
    const runOnce = () =>
      ext.wrapProviderRunner!(
        ctx,
        { model: ctx.model } as never,
        (async () => {
          call++;
          if (call === 1 || call === 3) throw overload('anthropic');
          return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
        }) as never,
      );

    await runOnce();
    expect(ctx.model).toBe('haiku');
    t = 100;
    await ext.beforeRun!(ctx, {} as never);
    expect(ctx.model).toBe('opus');

    await runOnce();
    expect(ctx.model).toBe('haiku');
    t = 299;
    await ext.beforeRun!(ctx, {} as never);
    expect(ctx.model).toBe('haiku');
    t = 300;
    await ext.beforeRun!(ctx, {} as never);
    expect(ctx.model).toBe('opus');
  });
});

describe('smartDefaultFallbackChain', () => {
  it('derives a same-provider-first chain from keyed providers, excluding the leader model', () => {
    const config = cfg({
      provider: 'anthropic',
      model: 'opus',
      providers: {
        anthropic: { type: 'anthropic', apiKey: 'k', models: ['opus', 'planner', 'haiku'] },
        openai: { type: 'openai', apiKey: 'k', models: ['gpt-4o'] },
      },
    } as never);
    expect(smartDefaultFallbackChain(config)).toEqual([
      'anthropic/planner',
      'anthropic/haiku',
      'openai/gpt-4o',
    ]);
  });

  it('skips providers without a key and returns [] when nothing usable', () => {
    expect(smartDefaultFallbackChain(cfg({ providers: {} } as never))).toEqual([]);
    const noKey = cfg({
      providers: { openai: { type: 'openai', models: ['gpt-4o'] } },
    } as never);
    expect(smartDefaultFallbackChain(noKey)).toEqual([]);
  });

  it('caps the derived chain at 4 entries', () => {
    const config = cfg({
      providers: {
        anthropic: {
          type: 'anthropic',
          apiKey: 'k',
          models: ['opus', 'm1', 'm2', 'm3', 'm4', 'm5'],
        },
      },
    } as never);
    expect(smartDefaultFallbackChain(config)).toHaveLength(4);
  });
});

describe('effectiveFallbackChain', () => {
  const providers = {
    anthropic: { type: 'anthropic', apiKey: 'k', models: ['opus', 'planner'] },
  };

  it('prefers an explicit list over the smart default', () => {
    expect(effectiveFallbackChain(cfg({ fallbackModels: ['x/y'], providers } as never))).toEqual([
      'x/y',
    ]);
  });

  it('uses the smart default when the explicit list is empty and auto is on', () => {
    expect(effectiveFallbackChain(cfg({ fallbackModels: [], providers } as never))).toEqual([
      'anthropic/planner',
    ]);
  });

  it('returns [] when the explicit list is empty and auto is off', () => {
    expect(
      effectiveFallbackChain(cfg({ fallbackModels: [], fallbackAuto: false, providers } as never)),
    ).toEqual([]);
  });
});
