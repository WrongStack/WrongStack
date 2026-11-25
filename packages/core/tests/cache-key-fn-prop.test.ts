import { describe, expect, it } from 'vitest';
import { deriveCachePrefixKey } from '../src/utils/cache-key.js';

describe('deriveCachePrefixKey non-JSON property omission', () => {
  it('omits function and symbol properties just like JSON.stringify instead of hashing them as null', () => {
    const prompt = [{ type: 'text' as const, text: 'sys' }];
    const keyWithFn = deriveCachePrefixKey(prompt, [
      { name: 't', description: 'd', inputSchema: { type: 'object', helper: () => {} } } as never,
    ]);
    const keyWithNull = deriveCachePrefixKey(prompt, [
      { name: 't', description: 'd', inputSchema: { type: 'object', helper: null } } as never,
    ]);
    const keyClean = deriveCachePrefixKey(prompt, [
      { name: 't', description: 'd', inputSchema: { type: 'object' } } as never,
    ]);
    expect(keyWithFn).toBe(keyClean);
    expect(keyWithFn).not.toBe(keyWithNull);
  });
});
