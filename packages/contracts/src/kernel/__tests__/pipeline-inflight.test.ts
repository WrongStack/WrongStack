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
});
