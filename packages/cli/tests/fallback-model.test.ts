import {
  createFallbackModelExtension,
  effectiveFallbackChain,
  parseModelRef,
  smartDefaultFallbackChain,
} from '@wrongstack/core/agent';
import { EventBus } from '@wrongstack/core/kernel';
import { type Config, type Provider, ProviderError } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function fakeProvider(id: string, modelId?: string): Provider {
  const maxContext = modelId === 'small' ? 32_000 : 200_000;
  return {
    id,
    capabilities: { maxContext } as never,
    complete: vi.fn(),
    stream: vi.fn(),
  } as Provider;
}

function makeCtx(providerId: string, model: string) {
  return {
    provider: fakeProvider(providerId),
    model,
    // Every event the fallback chain emits is stamped with the session that
    // owns the in-flight run; a context without one is rejected at emit time.
    activeRunSessionId: 'sess_test',
  } as never as import('@wrongstack/core/agent').Context;
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
  it('preserves explicit fallback entries even when provider has empty model list', () => {
    expect(
      effectiveFallbackChain(
        cfg({
          provider: 'anthropic',
          model: 'opus',
          fallbackModels: ['planner', 'openai/gpt-x'],
          providers: {
            anthropic: { type: 'anthropic', models: ['haiku'] },
            openai: { type: 'openai', models: [] },
          },
        }),
      ),
    ).toHaveLength(2); // explicit entries trusted; provider model lists only affect auto-derivation
  });

  it('smart default only uses visible provider models', () => {
    expect(
      smartDefaultFallbackChain(
        cfg({
          provider: 'anthropic',
          model: 'opus',
          providers: {
            anthropic: { type: 'anthropic', apiKey: 'x', models: ['haiku'] },
            openai: { type: 'openai', apiKey: 'y', models: ['gpt-x'] },
          },
        }),
      ),
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

  it('treats a closed worker policy as a hard boundary', async () => {
    const buildProvider = vi.fn((id: string) => fakeProvider(id));
    const ext = createFallbackModelExtension({
      getConfig: () =>
        cfg({
          providers: {
            anthropic: { type: 'anthropic', apiKey: 'x', models: ['opus', 'haiku'] },
            openai: { type: 'openai', apiKey: 'x', models: ['worker', 'backup'] },
          },
        } as never),
      getPrimaryTarget: () => ({ providerId: 'openai', model: 'worker' }),
      getFallbackModels: () => ['openai/backup'],
      isClosedWorld: () => true,
      buildProvider,
      events: new EventBus(),
      logger,
    });
    const ctx = makeCtx('openai', 'worker');
    const err = overload('openai');
    await expect(
      ext.wrapProviderRunner!(
        ctx,
        { model: 'worker' } as never,
        (async () => {
          throw err;
        }) as never,
      ),
    ).rejects.toBe(err);

    expect(buildProvider).toHaveBeenCalledTimes(1);
    expect(buildProvider).toHaveBeenCalledWith('openai', 'backup');
  });

  it('restores the worker-local primary instead of the leader model', async () => {
    const buildProvider = vi.fn((id: string) => fakeProvider(id));
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ provider: 'anthropic', model: 'leader' }),
      getPrimaryTarget: () => ({ providerId: 'openai', model: 'worker' }),
      getFallbackModels: () => ['openai/backup'],
      isClosedWorld: () => true,
      primaryCooldownMs: 0,
      buildProvider,
      events: new EventBus(),
      logger,
    });
    const ctx = makeCtx('openai', 'worker');
    let call = 0;
    await ext.wrapProviderRunner!(
      ctx,
      { model: 'worker' } as never,
      (async () => {
        call++;
        if (call === 1) throw overload('openai');
        return { stopReason: 'end_turn', usage: { input: 0, output: 0 } } as never;
      }) as never,
    );
    expect(ctx.model).toBe('backup');

    await ext.beforeRun!(ctx, {} as never);
    expect(ctx.provider.id).toBe('openai');
    expect(ctx.model).toBe('worker');
    expect(buildProvider).not.toHaveBeenCalledWith('anthropic', 'leader');
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

  it('tries a manually selected live config model before the configured fallback chain', async () => {
    const events = new EventBus();
    const fired: Array<{ to: { providerId: string; model: string } }> = [];
    events.on('provider.fallback', (p) => fired.push(p as never));

    let liveCfg = cfg({ provider: 'anthropic', model: 'opus', fallbackModels: ['haiku'] });
    const buildProvider = vi.fn((id: string, _model?: string) => fakeProvider(id));
    const ext = createFallbackModelExtension({
      getConfig: () => liveCfg,
      buildProvider,
      events,
      logger,
    })!;

    const ctx = makeCtx('anthropic', 'opus');
    liveCfg = cfg({ provider: 'openai', model: 'gpt-x', fallbackModels: ['haiku'] });

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
    expect(ctx.provider.id).toBe('openai');
    expect(ctx.model).toBe('gpt-x');
    expect(fired[0]?.to).toEqual({ providerId: 'openai', model: 'gpt-x' });
  });

  it('emits a context-window warning when fallback moves to a smaller model window', async () => {
    const events = new EventBus();
    const fired: Array<{
      contextWindowWarning?: {
        fromMaxContext: number;
        toMaxContext: number;
        currentTokens?: number;
      };
    }> = [];
    events.on('provider.fallback', (p) => fired.push(p as never));
    const ext = createFallbackModelExtension({
      getConfig: () => cfg({ fallbackModels: ['openai/gpt-small'] }),
      buildProvider: (id: string) => fakeProvider(id, id === 'openai' ? 'small' : 'large'),
      events,
      logger,
    })!;

    const ctx = makeCtx('anthropic', 'opus') as import('@wrongstack/core/agent').Context;
    ctx.provider = fakeProvider('anthropic', 'large');
    ctx.lastRequestTokens = 24_000;

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

    expect(fired[0]?.contextWindowWarning).toEqual({
      fromMaxContext: 200_000,
      toMaxContext: 32_000,
      currentTokens: 24_000,
    });
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
