import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MCPTaskChanges } from '../src/task-changes.js';

const { watch } = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock('node:fs', () => ({ watch }));

class TestWatcher extends EventEmitter {
  close = vi.fn();
  unref = vi.fn();
  constructor(readonly change: () => void) {
    super();
  }
}

const watchers: TestWatcher[] = [];
let changes: MCPTaskChanges;

beforeEach(() => {
  vi.useFakeTimers();
  watchers.length = 0;
  watch.mockReset().mockImplementation((_directory, notify) => {
    const watcher = new TestWatcher(() => notify('change', 'journal.json'));
    watchers.push(watcher);
    return watcher;
  });
  changes = new MCPTaskChanges('fixture');
});

afterEach(() => {
  changes.dispose();
  vi.useRealTimers();
});

it('does not let retired watcher events close or invalidate the replacement', async () => {
  const listener = vi.fn();
  changes.subscribe(listener, () => {});
  await vi.advanceTimersByTimeAsync(30_050);
  const [old, current] = watchers;
  expect(old!.close).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledTimes(1);
  old!.change();
  old!.emit('error', new Error('retired'));
  await vi.advanceTimersByTimeAsync(50);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(current!.close).not.toHaveBeenCalled();

  current!.change();
  await vi.advanceTimersByTimeAsync(50);
  expect(listener).toHaveBeenCalledTimes(2);
  current!.emit('error', new Error('current'));
  await vi.advanceTimersByTimeAsync(50);
  expect(current!.close).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledTimes(3);
});

it.each(['dispose', 'unsubscribe'] as const)(
  'skips subscribers removed during notification (%s)',
  async (mode) => {
    const change = vi.fn();
    const close = vi.fn();
    changes.subscribe(
      () => {
        if (mode === 'dispose') changes.dispose();
        else unsubscribe();
      },
      () => {},
    );
    const unsubscribe = changes.subscribe(change, close);
    changes.invalidate();
    await vi.advanceTimersByTimeAsync(50);
    expect(change).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(mode === 'dispose' ? 1 : 0);
  },
);
