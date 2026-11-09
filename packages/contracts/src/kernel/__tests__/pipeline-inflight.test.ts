import { describe, expect, it } from 'vitest';
import { Pipeline } from '../pipeline.js';

describe('Pipeline in-flight registration changes', () => {
  it('runs the original chain once despite a prepend, then uses the new chain on the next run', async () => {
    const pipeline = new Pipeline<number>();
    let entered!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const calls: string[] = [];
    pipeline.use({
      name: 'first',
      handler: async (value: number, next: (value: number) => Promise<number>) => {
        calls.push('first');
        entered();
        await gate;
        return next(value);
      },
    });
    pipeline.use({
      name: 'required',
      handler: async (value: number, next: (value: number) => Promise<number>) => {
        calls.push('required');
        return next(value + 1);
      },
    });

    const inFlight = pipeline.run(0);
    await paused;
    pipeline.prepend({
      name: 'new',
      handler: async (value: number, next: (value: number) => Promise<number>) => next(value + 100),
    });
    resume();

    expect(await inFlight).toBe(1);
    expect(calls).toEqual(['first', 'required']);
    expect(await pipeline.run(0)).toBe(101);
  });

  it('does not skip an in-flight downstream stage when another owner removes an earlier stage', async () => {
    const pipeline = new Pipeline<number>();
    pipeline.use({
      name: 'before',
      handler: async (value: number, next: (value: number) => Promise<number>) => next(value + 1),
    });
    let entered!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    pipeline.use({
      name: 'waiting',
      handler: async (value: number, next: (value: number) => Promise<number>) => {
        entered();
        await gate;
        return next(value + 10);
      },
    });
    pipeline.use({
      name: 'after',
      handler: async (value: number, next: (value: number) => Promise<number>) => next(value + 100),
    });

    const inFlight = pipeline.run(0);
    await paused;
    pipeline.remove('before');
    resume();

    expect(await inFlight).toBe(111);
    expect(await pipeline.run(0)).toBe(110);
  });

  it('routes duplicate next() calls through errorHandler and normalizes insertAt indices (F87)', async () => {
    const pipeline = new Pipeline<number>().setErrorHandler(() => 'swallow');
    pipeline.use({
      name: 'double-next',
      handler: async (value: number, next: (value: number) => Promise<number>) => {
        await next(value + 1);
        return next(value + 2);
      },
    });
    pipeline.insertAt(Number.NaN, {
      name: 'front',
      handler: async (value: number, next: (value: number) => Promise<number>) => next(value + 10),
    });
    expect(pipeline.list()).toEqual(['front', 'double-next']);
    expect(await pipeline.run(5)).toBe(15);
  });

  it('survives a throwing operational logger on swallow and rethrows when errorHandler returns non-swallow (F121)', async () => {
    const swallowPipe = new Pipeline<number>()
      .setErrorHandler(() => 'swallow')
      .setLogger({
        warn: () => {
          throw new Error('logger disk full');
        },
      });
    swallowPipe.use({
      name: 'crashes',
      handler: async () => {
        throw new Error('plugin crash');
      },
    });
    expect(await swallowPipe.run(42)).toBe(42);
  });
});
