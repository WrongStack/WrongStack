import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamCoalescer } from '@/lib/stream-coalescer';

describe('StreamCoalescer', () => {
  let rafCbs: Array<() => void>;
  beforeEach(() => {
    rafCbs = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const tick = () => {
    const cbs = rafCbs;
    rafCbs = [];
    for (const cb of cbs) cb();
  };

  it('batches multiple pushes for one key into a single flush', () => {
    const c = new StreamCoalescer();
    const flush = vi.fn();
    c.push('a', 'foo', flush);
    c.push('a', 'bar', flush);
    c.push('a', 'baz', flush);
    expect(flush).not.toHaveBeenCalled(); // nothing until the frame
    tick();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('a', 'foobarbaz');
  });

  it('keeps separate buffers per key', () => {
    const c = new StreamCoalescer();
    const flush = vi.fn();
    c.push('a', 'A', flush);
    c.push('b', 'B', flush);
    tick();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledWith('a', 'A');
    expect(flush).toHaveBeenCalledWith('b', 'B');
  });

  it('flush(key) drains synchronously and removes the pending frame work', () => {
    const c = new StreamCoalescer();
    const flush = vi.fn();
    c.push('a', 'hello', flush);
    c.flush('a');
    expect(flush).toHaveBeenCalledWith('a', 'hello');
    tick(); // no double emit
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('drop(key) discards buffered text without flushing', () => {
    const c = new StreamCoalescer();
    const flush = vi.fn();
    c.push('t', 'thinking…', flush);
    c.drop('t');
    tick();
    expect(flush).not.toHaveBeenCalled();
  });

  it('flushAll drains every key', () => {
    const c = new StreamCoalescer();
    const flush = vi.fn();
    c.push('a', '1', flush);
    c.push('b', '2', flush);
    c.flushAll();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('ignores empty pushes', () => {
    const c = new StreamCoalescer();
    const flush = vi.fn();
    c.push('a', '', flush);
    tick();
    expect(flush).not.toHaveBeenCalled();
  });
});
