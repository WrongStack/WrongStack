import { describe, expect, it } from 'vitest';
import { SSEReader } from '../src/sse-reader.js';

describe('SSE reader callback ownership', () => {
  for (const kind of ['message', 'endpoint'] as const) {
    it.each(['self-off', 'reset'] as const)(
      `${kind} handles callback %s without stale or skipped observers`,
      async (mode) => {
        const reader = new SSEReader();
        const seen: string[] = [];
        const on = (cb: () => void) =>
          kind === 'message' ? reader.onMessage(cb) : reader.onEndpoint(cb);
        let off!: () => void;
        off = on(() => {
          seen.push('first');
          if (mode === 'self-off') off();
          else reader.reset();
        });
        on(() => seen.push('second'));
        const gate = Promise.withResolvers<void>();
        const done = gate.promise.then(() =>
          reader.feed(
            kind === 'message' ? 'data: {"id":1}\n\n' : 'event: endpoint\ndata: /messages\n\n',
          ),
        );
        gate.resolve();
        await done;
        expect(seen).toEqual(mode === 'self-off' ? ['first', 'second'] : ['first']);
      },
    );
  }

  it('ignores non-object JSON frames (null, primitives, arrays)', () => {
    const reader = new SSEReader();
    const received: unknown[] = [];
    reader.onMessage((msg) => received.push(msg));
    reader.feed('data: null\n\ndata: 123\n\ndata: []\n\ndata: {"jsonrpc":"2.0","id":1}\n\n');
    expect(received).toEqual([{ jsonrpc: '2.0', id: 1 }]);
  });
});
