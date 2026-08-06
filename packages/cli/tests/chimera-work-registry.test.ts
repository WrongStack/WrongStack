import { describe, expect, it, vi } from 'vitest';
import { createChimeraWorkRegistry } from '../src/chimera-work-registry.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Chimera work registry', () => {
  it('drains overlapping reviews instead of retaining only the newest promise', async () => {
    const registry = createChimeraWorkRegistry();
    const first = deferred();
    const second = deferred();

    expect(registry.track(first.promise)).toBe(true);
    expect(registry.track(second.promise)).toBe(true);

    let drained = false;
    const drain = registry.drainAndClose().then(() => {
      drained = true;
    });

    second.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    first.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('drains descendant work registered while an earlier batch is settling', async () => {
    const registry = createChimeraWorkRegistry();
    const cascade = deferred();
    const order: string[] = [];

    const review = Promise.resolve().then(() => {
      order.push('review');
      expect(registry.track(cascade.promise.then(() => { order.push('cascade'); }))).toBe(true);
    });
    registry.track(review);

    const drain = registry.drainAndClose().then(() => order.push('drained'));
    await vi.waitFor(() => expect(order).toEqual(['review']));

    cascade.resolve();
    await drain;
    expect(order).toEqual(['review', 'cascade', 'drained']);
  });

  it('does not throw when late work arrives after the registry is closed', async () => {
    const registry = createChimeraWorkRegistry();
    await registry.drainAndClose();

    expect(registry.track(Promise.resolve())).toBe(false);
    expect(registry.size).toBe(0);
  });
});
