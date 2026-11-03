import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopSurfaceHost } from '../src/desktop-surface-host';
import type { BackendStream } from '../src/engine-stream';
import { JournalTail } from '../src/journal-tail';
import { request } from '../src/platform';

vi.mock('../src/platform', () => ({ request: vi.fn() }));
const mocked = vi.mocked(request);
const frame = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload });

afterEach(() => {
  vi.useRealTimers();
  mocked.mockReset();
});
describe('journal tail for the shared surfaces', () => {
  it('starts at the journal end and hands on only what is written afterwards', async () => {
    vi.useFakeTimers();
    const reads: unknown[] = [];
    mocked.mockImplementation(async (_command, args) => {
      reads.push(args);
      const a = args as { tail?: boolean; offset?: number };
      if (a.tail) return { offset: 5000, events: [], hasMore: false, tail: true };
      return a.offset === 5000
        ? { offset: 5100, events: [frame('memory.sage.listPage', { requestId: 'r1' })] }
        : { offset: a.offset, events: [] };
    });
    const tail = new JournalTail('p1', 50);
    const seen: string[] = [];
    const stop = tail.listen((event) => seen.push(event.type));
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toEqual(['memory.sage.listPage']);
    expect(reads[0]).toEqual({ projectId: 'p1', tail: true });
    stop();
  });
  it('pages past an older host’s journal without handing its frames on', async () => {
    vi.useFakeTimers();
    mocked.mockImplementation(async (_command, args) => {
      const a = args as { tail?: boolean; offset?: number };
      // The older host ignores `tail` and answers from the start.
      const offset = a.tail ? 0 : (a.offset ?? 0);
      if (offset < 300)
        return {
          offset: offset + 100,
          events: [frame('memory.sage.listPage', { requestId: 'old' })],
          hasMore: true,
        };
      // The last page of what was already written, then a frame written after the tail began.
      if (offset === 300)
        return { offset: 400, events: [frame('memory.sage.listPage', { requestId: 'old' })] };
      return offset === 400
        ? { offset: 500, events: [frame('memory.sage.listPage', { requestId: 'new' })] }
        : { offset, events: [] };
    });
    const tail = new JournalTail('p2', 50);
    const seen: unknown[] = [];
    const stop = tail.listen((event) => seen.push(event.payload['requestId']));
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toEqual(['new']);
    stop();
  });
  it('gives a surface only replies to its own requests', async () => {
    let listener: ((event: { type: string; payload: Record<string, unknown> }) => void) | null =
      null;
    const tail = {
      ready: () => Promise.resolve(),
      listen: (next: typeof listener) => {
        listener = next;
        return () => {};
      },
    } as unknown as JournalTail;
    const sent: Record<string, unknown>[] = [];
    const stream = {
      send: async (_type: string, payload: Record<string, unknown>) => {
        sent.push(payload);
      },
    } as unknown as BackendStream;
    const { host, attach } = desktopSurfaceHost(
      stream,
      tail,
      async () => ({}),
      async () => true,
    );
    attach();
    const socket = host.useSageSocket();
    const replies: unknown[] = [];
    socket.client.on('memory.sage.listPage', (message) => replies.push(message.payload));
    socket.listSageMemoriesPage({ limit: 10 });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = sent[0]?.['requestId'];
    expect(typeof requestId).toBe('string');
    listener!(frame('memory.sage.listPage', { requestId: 'another-view', memories: [] }));
    listener!(frame('memory.sage.listPage', { requestId, memories: [1] }));
    expect(replies).toEqual([{ requestId, memories: [1] }]);
  });
});
