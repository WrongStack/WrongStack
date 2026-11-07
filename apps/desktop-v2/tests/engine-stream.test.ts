import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendStream, DORMANT_STREAM_LIMIT } from '../src/engine-stream';
import { request } from '../src/platform';

vi.mock('../src/platform', () => ({ request: vi.fn() }));
const mocked = vi.mocked(request);

afterEach(() => {
  vi.useRealTimers();
  mocked.mockReset();
});
describe('shared backend journal reader', () => {
  it('waits quietly while the project services are still starting', async () => {
    vi.useFakeTimers();
    let ready = false;
    mocked.mockImplementation(async () => {
      if (!ready) throw new Error('Project services have not started');
      return { offset: 4, events: [{ type: 'session.title', payload: { title: 'Up' } }] };
    });
    const stream = backendStream('project', 'starting');
    const onError = vi.fn();
    const stop = stream.subscribe({ changed: () => {}, onError });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onError).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(stream.state.hydrating).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });
  it('reports services that never start once the grace has passed', async () => {
    vi.useFakeTimers();
    mocked.mockRejectedValue(new Error('Project services have not started'));
    const stream = backendStream('project', 'never');
    const onError = vi.fn();
    const stop = stream.subscribe({ changed: () => {}, onError });
    // The reader keeps quiet for 30 seconds while the services start.
    await vi.advanceTimersByTimeAsync(31_500);
    expect(onError).toHaveBeenCalled();
    stop();
  });
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
    // Reopening continues from the position already read, with the state kept meanwhile.
    expect(backendStream('project', 'p1')).toBe(stream);
    const titled = stream.state;
    const stopAgain = stream.subscribe({ changed: vi.fn(), onError: () => {} });
    expect(stream.state).toBe(titled);
    await vi.advanceTimersByTimeAsync(300);
    expect(reads.slice(after).every((offset) => offset === 10)).toBe(true);
    expect(reads.filter((offset) => offset === 0)).toHaveLength(1);
    stopAgain();
  });
  it('drops the least recently closed readers beyond the dormant limit', async () => {
    vi.useFakeTimers();
    mocked.mockImplementation(async (_command, args) => ({
      offset: (args as { offset: number }).offset + 1,
      events: [],
    }));
    const opened = Array.from({ length: DORMANT_STREAM_LIMIT + 2 }, (_, i) => {
      const stream = backendStream('engine', `dormant-${i}`);
      return { stream, stop: stream.subscribe({ changed: () => {}, onError: () => {} }) };
    });
    await vi.advanceTimersByTimeAsync(0);
    for (const { stop } of opened) stop();
    expect(backendStream('engine', 'dormant-0')).not.toBe(opened[0]!.stream);
    expect(backendStream('engine', 'dormant-1')).not.toBe(opened[1]!.stream);
    expect(backendStream('engine', `dormant-${DORMANT_STREAM_LIMIT + 1}`)).toBe(
      opened.at(-1)!.stream,
    );
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
