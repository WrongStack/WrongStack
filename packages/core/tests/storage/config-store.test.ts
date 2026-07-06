import { describe, expect, it, vi } from 'vitest';
import { DefaultConfigStore } from '../../src/storage/config-store.js';
import type { Config } from '../../src/types/config.js';

const baseConfig: Config = {
  version: 1,
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  context: {
    warnThreshold: 0.7,
    softThreshold: 0.8,
    hardThreshold: 0.95,
    preserveK: 4,
    eliseThreshold: 0.5,
  },
  tools: {
    defaultExecutionStrategy: 'smart',
    maxIterations: 100,
    iterationTimeoutMs: 60_000,
    sessionTimeoutMs: 3_600_000,
    perIterationOutputCapBytes: 100_000,
  },
  log: { level: 'info' },
  features: {
    mcp: true,
    plugins: true,
    memory: true,
    modelsRegistry: true,
    skills: true,
  },
};

describe('DefaultConfigStore', () => {
  it('returns a frozen snapshot from get()', () => {
    const store = new DefaultConfigStore(baseConfig);
    const snap = store.get();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      // @ts-expect-error readonly
      snap.provider = 'openai';
    }).toThrow();
  });

  it('returns frozen nested objects too', () => {
    const store = new DefaultConfigStore(baseConfig);
    expect(Object.isFrozen(store.get().tools)).toBe(true);
    expect(Object.isFrozen(store.get().context)).toBe(true);
  });

  it('clones the initial config so external mutation does not leak in', () => {
    const initial: Config = JSON.parse(JSON.stringify(baseConfig));
    const store = new DefaultConfigStore(initial);
    // Mutating the original after construction must not affect the store.
    expect(() => {
      initial.provider = 'mutated';
    }).not.toThrow();
    expect(store.get().provider).toBe('anthropic');
  });

  it('getSection returns the requested slice', () => {
    const store = new DefaultConfigStore(baseConfig);
    const tools = store.getSection('tools');
    expect(tools.maxIterations).toBe(100);
  });

  it('getExtension returns a frozen record when configured', () => {
    const cfg: Config = {
      ...baseConfig,
      extensions: { 'wstack-auth': { tokenUrl: 'https://auth.example' } },
    };
    const store = new DefaultConfigStore(cfg);
    const ext = store.getExtension('wstack-auth');
    expect(ext.tokenUrl).toBe('https://auth.example');
    expect(Object.isFrozen(ext)).toBe(true);
  });

  it('getExtension returns frozen empty object when not configured', () => {
    const store = new DefaultConfigStore(baseConfig);
    const ext = store.getExtension('unknown-plugin');
    expect(ext).toEqual({});
    expect(Object.isFrozen(ext)).toBe(true);
  });

  it('update produces a new frozen snapshot', () => {
    const store = new DefaultConfigStore(baseConfig);
    const before = store.get();
    const after = store.update({ model: 'anthropic-test-model' });
    expect(after.model).toBe('anthropic-test-model');
    expect(after).not.toBe(before);
    expect(Object.isFrozen(after)).toBe(true);
  });

  it('notifies watchers synchronously with prev/next', () => {
    const store = new DefaultConfigStore(baseConfig);
    const watcher = vi.fn();
    store.watch(watcher);

    store.update({ model: 'anthropic-test-model' });

    expect(watcher).toHaveBeenCalledTimes(1);
    const [next, prev] = watcher.mock.calls[0]!;
    expect(next.model).toBe('anthropic-test-model');
    expect(prev.model).toBe('claude-opus-4-7');
  });

  it('unwatch removes the listener', () => {
    const store = new DefaultConfigStore(baseConfig);
    const watcher = vi.fn();
    const stop = store.watch(watcher);
    store.update({ model: 'a' });
    stop();
    store.update({ model: 'b' });
    expect(watcher).toHaveBeenCalledTimes(1);
  });

  it('a throwing watcher does not block others', () => {
    const store = new DefaultConfigStore(baseConfig);
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    store.watch(bad);
    store.watch(good);
    expect(() => store.update({ model: 'x' })).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('update enforces version invariant', () => {
    const store = new DefaultConfigStore(baseConfig);
    expect(() => store.update({ version: 2 as never })).toThrow(/version must remain 1/);
  });

  it('update merging preserves untouched fields', () => {
    const store = new DefaultConfigStore({
      ...baseConfig,
      extensions: { a: { foo: 1 } },
    });
    store.update({ model: 'changed' });
    expect(store.get().extensions?.a).toEqual({ foo: 1 });
  });

  it('extension namespace can be patched via update', () => {
    const store = new DefaultConfigStore(baseConfig);
    store.update({ extensions: { 'wstack-metrics': { port: 9090 } } });
    expect(store.getExtension('wstack-metrics')).toEqual({ port: 9090 });
  });

  it('watcher sees the new state on re-entrant get()', () => {
    const store = new DefaultConfigStore(baseConfig);
    let observed = '';
    store.watch(() => {
      observed = store.get().model;
    });
    store.update({ model: 'mid-flight' });
    expect(observed).toBe('mid-flight');
  });
});
