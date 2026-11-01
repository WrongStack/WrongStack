import { describe, expect, it } from 'vitest';
import { handleSageAudit } from '../src/server/memory-audit-handler.js';

function socket() {
  const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return { frames, ws: { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } };
}

const store = (records: unknown[], seen: number[] = []) =>
  ({
    getCapability: () => ({
      readAudit: async (limit: number) => {
        seen.push(limit);
        return records.slice(0, limit);
      },
    }),
  }) as never;

describe('memory.sage.audit', () => {
  const records = [
    { event: 'memory.injected', at: '3', details: { memoryIds: ['a'] } },
    { event: 'memory.used', at: '2' },
    { event: 'memory.injected', at: '1', details: { memoryIds: ['b'] } },
  ];

  it('returns the newest events and filters by event over the whole window', async () => {
    const seen: number[] = [];
    const { frames, ws } = socket();
    await handleSageAudit(
      ws as never,
      { payload: { event: 'memory.injected', limit: 1, requestId: 'r' } },
      store(records, seen),
    );
    expect(seen).toEqual([1000]);
    expect(frames[0]?.payload).toMatchObject({
      requestId: 'r',
      limit: 1,
      records: [{ at: '3' }],
    });
  });

  it('reports a store without an audit log', async () => {
    const { frames, ws } = socket();
    await handleSageAudit(ws as never, {}, { getCapability: () => undefined } as never);
    expect(typeof frames[0]?.payload['error']).toBe('string');
  });
});
