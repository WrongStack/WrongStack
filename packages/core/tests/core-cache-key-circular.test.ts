import { describe, expect, it } from 'vitest';
import { deriveCachePrefixKey } from '../src/utils/cache-key.js';

describe('deriveCachePrefixKey circular schema guard (F2289)', () => {
  it('hashes circular tool inputSchema without stack overflow', () => {
    const schema: Record<string, unknown> = { type: 'object' };
    schema.self = schema;
    const key = deriveCachePrefixKey(
      [{ type: 'text', text: 'sys' }],
      [{ name: 'demo', description: 'd', inputSchema: schema } as never],
    );
    expect(key.startsWith('ws-')).toBe(true);
  });
});
