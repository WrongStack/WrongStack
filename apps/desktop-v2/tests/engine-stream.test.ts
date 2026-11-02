import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendStream } from '../src/engine-stream';
import { request } from '../src/platform';

vi.mock('../src/platform', () => ({ request: vi.fn() }));
const mocked = vi.mocked(request);

afterEach(() => {
  vi.useRealTimers();
  mocked.mockReset();
});
describe('shared backend journal reader', () => {
  it('reads one project journal once for every view and stops with the last view', async () => {
    vi.useFakeTimers();
    const reads: number[] = [];
    mocked.mockImplementation(async (_command, args) => {
      const offset = (args as { offset: number }).offset;
      reads.push(offset);
      return offset === 0
        ? { offset: 10, events: [{ type: 'session.title', payload: { title: 'Shared' } }] }
        : { offset, events: [] };
    });
    const stream = backendStream('project', 'p1');
    const first = vi.fn();
    const stopFirst = stream.subscribe({ changed: first, onError: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.state.hydrating).toBe(false);
    // A view that opens later shares the reader and the state already read.
    expect(backendStream('project', 'p1')).toBe(stream);
    const stopSecond = stream.subscribe({ changed: vi.fn(), onError: () => {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads.filter((offset) => offset === 0)).toHaveLength(1);
    // Idle polls do not re-render.
    expect(first).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
    const after = reads.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toHaveLength(after);
    expect(backendStream('project', 'p1')).not.toBe(stream);
  });
  it('keeps a single reader across a quick unsubscribe and resubscribe', async () => {
    vi.useFakeTimers();
    let reads = 0;
    mocked.mockImplementation(async (_command, args) => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { offset: (args as { offset: number }).offset, events: [] };
    });
    const stream = backendStream('project', 'p2');
    stream.subscribe({ changed: () => {}, onError: () => {} })();
    const stop = stream.subscribe({ changed: () => {}, onError: () => {} });
    await vi.advanceTimersByTimeAsync(300);
    const settled = reads;
    // One reader polls every 150 ms here (50 ms read, 100 ms pause); two would double it.
    await vi.advanceTimersByTimeAsync(1500);
    expect(reads - settled).toBeLessThanOrEqual(11);
    stop();
  });
});
