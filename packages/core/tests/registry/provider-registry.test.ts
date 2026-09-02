import { describe, expect, it } from 'vitest';
import { ProviderRegistry, type ProviderFactory } from '../../src/registry/provider-registry.js';
import type { Provider } from '../../src/types/provider.js';

const fakeProvider: Provider = {
  id: 'fake',
  capabilities: {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: false,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    maxContext: 1000,
    cacheControl: 'none',
  },
  async complete() {
    return {
      content: [],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
      model: 'fake',
    };
  },
};

const makeFactory = (type: string, create?: (cfg: unknown) => Provider): ProviderFactory => ({
  type,
  family: 'openai-compatible' as const,
  create: create ?? (() => fakeProvider),
});

describe('ProviderRegistry', () => {
  it('register / has / create / list', () => {
    const r = new ProviderRegistry();
    r.register(makeFactory('fake'));
    expect(r.has('fake')).toBe(true);
    expect(r.list()).toEqual(['fake']);
    expect(r.create({ type: 'fake' })).toBe(fakeProvider);
  });

  it('unknown type throws on create', () => {
    const r = new ProviderRegistry();
    expect(() => r.create({ type: 'missing' })).toThrow(/not registered/);
  });

  it('registerAll registers multiple factories', () => {
    const r = new ProviderRegistry();
    r.registerAll([makeFactory('a'), makeFactory('b')]);
    expect(r.list()).toEqual(['a', 'b']);
    expect(r.has('a')).toBe(true);
    expect(r.has('b')).toBe(true);
  });

  it('registerAll does not throw on duplicate type (replaces)', () => {
    const r = new ProviderRegistry();
    r.register(makeFactory('a'));
    // Should not throw — register replaces existing factory
    r.register(makeFactory('a'));
    expect(r.list()).toEqual(['a']);
  });

  it('override throws when type not registered', () => {
    const r = new ProviderRegistry();
    expect(() => r.override('unknown', makeFactory('unknown'))).toThrow(
      /not registered.*cannot override/,
    );
  });

  it('override replaces existing factory', () => {
    const r = new ProviderRegistry();
    let _callCount = 0;
    r.register(makeFactory('a', () => ({ ...fakeProvider, id: 'first' })));
    r.override(
      'a',
      makeFactory('a', () => {
        _callCount++;
        return { ...fakeProvider, id: 'second' };
      }),
    );
    const prov = r.create({ type: 'a' }) as typeof fakeProvider & { id: string };
    expect(prov.id).toBe('second');
  });

  it('has returns false for unregistered type', () => {
    const r = new ProviderRegistry();
    expect(r.has('nope')).toBe(false);
  });

  it('create passes config to factory', () => {
    const r = new ProviderRegistry();
    let receivedConfig: unknown;
    r.register({
      type: 'config-test',
      family: 'openai-compatible',
      create(cfg) {
        receivedConfig = cfg;
        return fakeProvider;
      },
    });
    const cfg = { type: 'config-test', model: 'gpt-4' } as const;
    r.create(cfg);
    expect(receivedConfig).toBe(cfg);
  });

  it('list returns empty when registry is empty', () => {
    const r = new ProviderRegistry();
    expect(r.list()).toEqual([]);
  });

  it('has returns true for registered type', () => {
    const r = new ProviderRegistry();
    r.register(makeFactory('test'));
    expect(r.has('test')).toBe(true);
  });

  it('error message on create includes available types', () => {
    const r = new ProviderRegistry();
    r.register(makeFactory('alpha'));
    r.register(makeFactory('beta'));
    const msg = tryCreateError(r, 'gamma');
    expect(msg).toContain('alpha');
    expect(msg).toContain('beta');
  });
});

function tryCreateError(r: ProviderRegistry, type: string): string {
  try {
    r.create({ type } as Parameters<typeof r.create>[0]);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
