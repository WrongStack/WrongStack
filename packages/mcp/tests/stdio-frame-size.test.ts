import { describe, expect, it } from 'vitest';
import { type ClientStdioProtocolHost, receiveStdioData } from '../src/client-stdio-protocol.js';

const LIMIT = 16 * 1024 * 1024;

function receiver() {
  const lines: string[] = [];
  let closed = 0;
  const host = {
    rxParts: [],
    rxBufferBytes: 0,
    opts: { name: 'fixture' },
    onLine: (line: string) => lines.push(line),
    failPending: () => {},
    close: async () => {
      closed++;
    },
  } as unknown as ClientStdioProtocolHost;
  return { host, lines, closed: () => closed };
}

describe('stdio receive frame limit', () => {
  it('accepts adjacent valid frames regardless of their pipe chunk boundaries', () => {
    const first = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(LIMIT - 100) });
    const second = JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'y'.repeat(200) });
    for (const chunks of [
      [first + '\n', second + '\n'],
      [first.slice(0, -10), first.slice(-10) + '\n' + second + '\n'],
    ]) {
      const { host, lines, closed } = receiver();
      for (const chunk of chunks) receiveStdioData(host, chunk);
      expect(lines).toEqual([first, second]);
      expect(closed()).toBe(0);
      expect(host.rxBufferBytes).toBe(0);
    }
  });

  it('accepts an exact-limit frame and retains only the next partial tail', () => {
    const { host, lines, closed } = receiver();
    const first = 'x'.repeat(LIMIT);
    receiveStdioData(host, first + '\nnext');
    expect(lines).toEqual([first]);
    expect(host.rxParts).toEqual(['next']);
    expect(host.rxBufferBytes).toBe(4);
    expect(closed()).toBe(0);
  });

  it('still rejects a single oversized fragmented frame', () => {
    const { host, lines, closed } = receiver();
    receiveStdioData(host, 'x'.repeat(LIMIT));
    receiveStdioData(host, 'x\n');
    expect(lines).toEqual([]);
    expect(closed()).toBe(1);
    expect(host.rxParts).toEqual([]);
    expect(host.rxBufferBytes).toBe(0);
  });
});
