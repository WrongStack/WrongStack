import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopSurfaceHost } from '../src/desktop-surface-host';
import { emptyEngineState } from '../src/engine-state';
import type { BackendStream } from '../src/engine-stream';
import { JournalTail, projectRequest } from '../src/journal-tail';
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
  it('answers a one-off project request from the journal end without replaying it', async () => {
    vi.useFakeTimers();
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    const reads: { tail?: boolean; offset?: number }[] = [];
    mocked.mockImplementation(async (command, args) => {
      const a = args as { tail?: boolean; offset?: number; message?: (typeof sent)[number] };
      if (command === 'project.send') {
        sent.push(a.message!);
        return null;
      }
      reads.push(a);
      if (a.tail) return { offset: 900_000_000, events: [], hasMore: false, tail: true };
      const requestId = sent[0]?.payload['requestId'];
      return requestId && a.offset === 900_000_000
        ? {
            offset: 900_000_100,
            events: [
              frame('prompts.journal', { requestId: 'someone-else', entries: [] }),
              frame('prompts.journal', { requestId, entries: [{ content: 'hi' }] }),
            ],
          }
        : { offset: a.offset, events: [] };
    });
    const reply = projectRequest(
      'p3',
      'prompts.journal',
      { filter: { limit: 5 } },
      ['prompts.journal'],
      { tail: new JournalTail('p3', 20) },
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(reply).resolves.toEqual(expect.objectContaining({ entries: [{ content: 'hi' }] }));
    expect(sent).toEqual([
      { type: 'prompts.journal', payload: expect.objectContaining({ filter: { limit: 5 } }) },
    ]);
    // Never a read from the journal's start: the first read locates the end.
    expect(reads[0]).toEqual({ projectId: 'p3', tail: true });
    expect(reads.some((read) => read.offset === 0)).toBe(false);
  });
  it('rejects a one-off project request the engine refuses', async () => {
    vi.useFakeTimers();
    let requestId: unknown;
    mocked.mockImplementation(async (command, args) => {
      const a = args as {
        tail?: boolean;
        offset?: number;
        message?: { payload: Record<string, unknown> };
      };
      if (command === 'project.send') {
        requestId = a.message!.payload['requestId'];
        return null;
      }
      if (a.tail) return { offset: 10, events: [], hasMore: false, tail: true };
      return requestId
        ? { offset: 20, events: [frame('error', { requestId, message: 'no skills here' })] }
        : { offset: a.offset, events: [] };
    });
    const reply = projectRequest('p4', 'skills.list', {}, ['skills.list'], {
      tail: new JournalTail('p4', 20),
    });
    const settled = expect(reply).rejects.toThrow('no skills here');
    await vi.advanceTimersByTimeAsync(100);
    await settled;
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
      state: emptyEngineState,
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
