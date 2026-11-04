import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { desktopSurfaceHost } from '../src/desktop-surface-host';

vi.mock('../src/platform', () => ({ request: vi.fn() }));

const manager = readFileSync(
  resolve(__dirname, '../../../packages/project-surfaces/src/sage/MemoryManager.tsx'),
  'utf8',
);

describe('SAGE replies awaited by an ack reach it on the desktop', () => {
  it('sends every ack-awaited SAGE request under the ack id', () => {
    // The desktop host tags every request; an ack that is not sent under its own id would
    // read its reply as another operation's and time out.
    const calls = [
      ...manager.matchAll(/sendWithAck\(\s*'([\w.]+)',\s*(?:\/\/[^\n]*\n\s*)*([^,]+?)=>/g),
    ];
    expect(calls.map((call) => call[1])).toEqual([
      'memory.sage.recover',
      'memory.sage.candidateResolve',
      'memory.sage.candidateResolve',
      'memory.sage.update',
    ]);
    for (const call of calls) expect(call[2]?.trim(), call[1]).toBe('(requestId)');
  });

  it('keeps the id a request carries in its payload', async () => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const stream = {
      send: async (type: string, payload: Record<string, unknown>) => {
        sent.push({ type, payload });
      },
      operations: { request: async () => ({}) },
    };
    const tail = { ready: async () => undefined, listen: () => () => undefined };
    const { send } = desktopSurfaceHost(
      stream as never,
      tail as never,
      (async () => ({})) as never,
      async () => true,
    );
    send({ type: 'memory.sage.recover', payload: { id: 'm1', requestId: 'ack_1' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([
      { type: 'memory.sage.recover', payload: { id: 'm1', requestId: 'ack_1' } },
    ]);
  });
});
