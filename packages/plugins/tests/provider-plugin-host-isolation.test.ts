import type { Plugin, PluginAPI, Tool } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import escalate from '../src/auto-escalate/index.js';
import cache from '../src/llm-cache/index.js';
import router from '../src/model-router/index.js';
import firewall from '../src/prompt-firewall/index.js';
import throttle from '../src/token-throttle/index.js';

type Extension = {
  wrapProviderRunner?: (
    ctx: unknown,
    request: unknown,
    inner: (ctx: unknown, request: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  beforeRun?: (ctx?: unknown) => void;
  onError?: (ctx: unknown, error: unknown, phase: unknown) => unknown;
};
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.useRealTimers();
});
function host(plugin: Plugin, config: Record<string, unknown> = {}) {
  const tools = new Map<string, Tool>();
  const live = new Set<Extension>();
  const api = {
    config: { extensions: { [plugin.name]: config } },
    tools: { register: (tool: Tool) => tools.set(tool.name, tool) },
    extensions: {
      register: (extension: Extension) => {
        live.add(extension);
        return () => live.delete(extension);
      },
    },
    log: { info() {}, warn() {}, error() {} },
    metrics: { counter() {}, histogram() {} },
    emitCustom() {},
  } as unknown as PluginAPI;
  plugin.setup(api);
  cleanup.push(() => plugin.teardown?.(api));
  return {
    api,
    live,
    tools,
    extension: [...live][0]!,
    async status(name: string) {
      return tools.get(name)!.execute({}, {} as never, { signal: new AbortController().signal });
    },
  };
}
const profiles = [
  [cache, {}, 'llm_cache_status'],
  [router, { rules: [{ model: 'small' }] }, 'model_router_status'],
  [throttle, {}, 'token_throttle_status'],
  [firewall, {}, 'prompt_firewall_status'],
  [escalate, { escalation: ['backup'] }, 'auto_escalate_status'],
] as const;
const request = { model: 'test', temperature: 0, messages: [{ role: 'user', content: 'hello' }] };
const response = (text: string) => ({
  model: 'test',
  stopReason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input: 2, output: 1 },
});

describe('provider plugin host isolation', () => {
  it('keeps retry positions independent for overlapping agent runs in one host', () => {
    const loaded = host(escalate, { escalation: ['first', 'second'] });
    const first = {};
    const second = {};
    const fail = (ctx: unknown) => loaded.extension.onError!(ctx, new Error('429'), 'provider');
    loaded.extension.beforeRun!(first);
    expect(fail(first)).toMatchObject({ model: 'first' });
    loaded.extension.beforeRun!(second);
    expect(fail(first)).toMatchObject({ model: 'second' });
    expect(fail(second)).toMatchObject({ model: 'first' });
    expect(fail(first)).toBeUndefined();
  });

  it('partitions cached responses by provider instance even when model names match', async () => {
    const loaded = host(cache);
    const first = { provider: { id: 'same-provider' } };
    const second = { provider: { id: 'same-provider' } };
    await loaded.extension.wrapProviderRunner!(first, request, async () => response('account A'));
    const inner = vi.fn(async () => response('account B'));
    expect(await loaded.extension.wrapProviderRunner!(second, request, inner)).toEqual(
      response('account B'),
    );
    expect(inner).toHaveBeenCalledOnce();
  });
  it.each(profiles)('%s cannot dispatch through an unloaded extension', async (plugin, config) => {
    const loaded = host(plugin, config);
    const inner = vi.fn(async () => response('unexpected'));
    await plugin.teardown?.(loaded.api);
    if (loaded.extension.wrapProviderRunner) {
      await expect(loaded.extension.wrapProviderRunner({}, request, inner)).rejects.toThrow();
      expect(inner).not.toHaveBeenCalled();
    } else {
      expect(loaded.extension.onError?.({}, new Error('429'), 'provider')).toBeUndefined();
    }
  });

  it('cancels a waiting throttle without dispatching another provider call', async () => {
    vi.useFakeTimers();
    const loaded = host(throttle, { tokensPerMinute: 1, maxDelayMs: 30000 });
    const inner = vi.fn(async () => response('first'));
    await loaded.extension.wrapProviderRunner!({}, request, inner);
    const controller = new AbortController();
    const pending = loaded.extension.wrapProviderRunner!(
      { signal: controller.signal },
      request,
      inner,
    );
    const assertion = expect(pending).rejects.toThrow();
    controller.abort();
    await assertion;
    expect(inner).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reload cancels a pending throttle and leaves the fresh window empty', async () => {
    vi.useFakeTimers();
    const loaded = host(throttle, { tokensPerMinute: 1, maxDelayMs: 30000 });
    const inner = vi.fn(async () => response('first'));
    await loaded.extension.wrapProviderRunner!({}, request, inner);
    const pending = loaded.extension.wrapProviderRunner!({}, request, inner);
    const assertion = expect(pending).rejects.toThrow();
    await throttle.setup(loaded.api);
    await assertion;
    expect(inner).toHaveBeenCalledTimes(1);
    expect(await loaded.status('token_throttle_status')).toMatchObject({ windowSpend: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a late old response cannot populate the cache of a reloaded host', async () => {
    const loaded = host(cache);
    let finish!: (value: unknown) => void;
    const pending = loaded.extension.wrapProviderRunner!(
      {},
      request,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const assertion = expect(pending).rejects.toThrow();
    await cache.setup(loaded.api);
    finish(response('old'));
    await assertion;
    expect(await loaded.status('llm_cache_status')).toMatchObject({
      size: 0,
      counters: { misses: 0 },
    });
  });
  it.each(profiles)(
    '%s keeps other hosts registered across setup, reload and teardown',
    async (plugin, config) => {
      const first = host(plugin, config);
      const second = host(plugin, config);
      expect(first.live.size).toBe(1);
      expect(second.live.size).toBe(1);
      await plugin.setup(first.api);
      expect(first.live.size).toBe(1);
      expect(second.live.size).toBe(1);
      await plugin.teardown?.(first.api);
      expect(first.live.size).toBe(0);
      expect(second.live.size).toBe(1);
    },
  );

  it.each(profiles)(
    '%s does not mix host counters or cache entries',
    async (plugin, config, tool) => {
      const first = host(plugin, config);
      const second = host(plugin, config);
      const before = await second.status(tool);
      if (first.extension.wrapProviderRunner)
        await first.extension.wrapProviderRunner({}, request, async () => response('first'));
      else first.extension.onError?.({}, new Error('429'), 'provider');
      expect(await second.status(tool)).toEqual(before);
    },
  );

  it('does not return a response generated by another host', async () => {
    const first = host(cache);
    const second = host(cache);
    await first.extension.wrapProviderRunner!({}, request, async () => response('first host'));
    const inner = vi.fn(async () => response('second host'));
    expect(await second.extension.wrapProviderRunner!({}, request, inner)).toEqual(
      response('second host'),
    );
    expect(inner).toHaveBeenCalledOnce();
  });
});
