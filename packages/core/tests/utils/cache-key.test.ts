import { describe, expect, it } from 'vitest';
import { deriveCachePrefixKey } from '../../src/utils/cache-key.js';
import { applyModelRuntime } from '../../src/execution/model-runtime.js';
import type { TextBlock } from '../../src/types/blocks.js';
import type { Request } from '../../src/types/provider.js';

const block = (text: string): TextBlock => ({ type: 'text', text });

describe('deriveCachePrefixKey', () => {
  it('produces a stable ws- prefixed key for the same content', () => {
    const a = [block('identity'), block('tools')];
    const b = [block('identity'), block('tools')];
    expect(deriveCachePrefixKey(a)).toMatch(/^ws-[0-9a-f]{32}$/);
    expect(deriveCachePrefixKey(a)).toBe(deriveCachePrefixKey(b)); // content-addressed
  });

  it('changes when the prefix content changes', () => {
    const a = [block('identity-v1')];
    const b = [block('identity-v2')];
    expect(deriveCachePrefixKey(a)).not.toBe(deriveCachePrefixKey(b));
  });

  it('caches by array identity (same reference returns the memoized value)', () => {
    const arr = [block('x')];
    const first = deriveCachePrefixKey(arr);
    // Mutating a member would change content, but the WeakMap is keyed on the
    // array ref — a frozen epoch array never mutates, so the cached value holds.
    expect(deriveCachePrefixKey(arr)).toBe(first);
  });

  it('incorporates tools deterministically and independently of registration order', () => {
    const system = [block('identity')];
    const toolA = { name: 'apple' } as any;
    const toolZ = { name: 'zebra' } as any;

    const keyWithoutTools = deriveCachePrefixKey(system);
    const keyWithToolsOrder1 = deriveCachePrefixKey(system, [toolZ, toolA]);
    const keyWithToolsOrder2 = deriveCachePrefixKey(system, [toolA, toolZ]);

    expect(keyWithToolsOrder1).toMatch(/^ws-[0-9a-f]{32}$/);
    expect(keyWithToolsOrder1).toBe(keyWithToolsOrder2);
    expect(keyWithToolsOrder1).not.toBe(keyWithoutTools);
  });
});

describe('applyModelRuntime — cache key survives the config ttl overlay', () => {
  const req = (cache?: Request['cache']): Request =>
    ({ model: 'm', messages: [], cache }) as Request;

  it('preserves a pre-set req.cache.key when config has no cache', () => {
    const out = applyModelRuntime(req({ key: 'ws-abc' }), {
      getSettings: () => ({ reasoning: { mode: 'auto' } }),
      getReasoningConfig: () => undefined,
    });
    expect(out.cache).toEqual({ key: 'ws-abc' });
  });

  it('merges config ttl onto the derived key (both survive)', () => {
    const out = applyModelRuntime(req({ key: 'ws-abc' }), {
      getSettings: () => ({ cache: { ttl: '1h' } }),
      getReasoningConfig: () => undefined,
    });
    expect(out.cache).toEqual({ key: 'ws-abc', ttl: '1h' });
  });
});
