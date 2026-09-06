import { describe, expect, it } from 'vitest';
import { Pipeline, type Middleware } from '../../src/kernel/pipeline.js';

function useMiddleware<T>(pipeline: Pipeline<T>, middleware: Middleware<T>): void {
  pipeline.use(middleware);
}

describe('Pipeline', () => {
  it('runs empty input unchanged', async () => {
    const p = new Pipeline<number>();
    expect(await p.run(1)).toBe(1);
  });

  it('chains middleware in order', async () => {
    const p = new Pipeline<number>();
    useMiddleware(p, { name: 'plus1', handler: async (v, next) => next(v + 1) });
    useMiddleware(p, { name: 'times2', handler: async (v, next) => next(v * 2) });
    expect(await p.run(1)).toBe(4);
  });

  it('respects prepend', async () => {
    const p = new Pipeline<number>();
    useMiddleware(p, { name: 'times2', handler: async (v, next) => next(v * 2) });
    p.prepend({ name: 'plus1', handler: async (v, next) => next(v + 1) });
    expect(await p.run(1)).toBe(4);
  });

  it('insertBefore and insertAfter', async () => {
    const p = new Pipeline<number>();
    useMiddleware(p, { name: 'a', handler: async (v, n) => n(v + 1) });
    useMiddleware(p, { name: 'c', handler: async (v, n) => n(v + 10) });
    p.insertAfter('a', { name: 'b', handler: async (v, n) => n(v + 100) });
    p.insertBefore('c', { name: 'b2', handler: async (v, n) => n(v + 1000) });
    expect(p.list()).toEqual(['a', 'b', 'b2', 'c']);
  });

  it('insertAt at arbitrary index', async () => {
    const p = new Pipeline<number>();
    useMiddleware(p, { name: 'a', handler: async (v, n) => n(v + 1) });
    useMiddleware(p, { name: 'b', handler: async (v, n) => n(v + 10) });
    useMiddleware(p, { name: 'c', handler: async (v, n) => n(v + 100) });
    p.insertAt(1, { name: 'x', handler: async (v, n) => n(v + 1000) });
    expect(p.list()).toEqual(['a', 'x', 'b', 'c']);
    expect(await p.run(0)).toBe(1111);
  });

  it('insertAt clamps out-of-range indices', async () => {
    const p = new Pipeline<number>();
    useMiddleware(p, { name: 'a', handler: async (v, n) => n(v + 1) });
    useMiddleware(p, { name: 'b', handler: async (v, n) => n(v + 10) });
    p.insertAt(99, { name: 'c', handler: async (v, n) => n(v + 100) });
    expect(p.list()).toEqual(['a', 'b', 'c']);
    p.insertAt(-5, { name: 'd', handler: async (v, n) => n(v + 1000) });
    expect(p.list()).toEqual(['d', 'a', 'b', 'c']);
  });

  it('replace and remove', async () => {
    const p = new Pipeline<number>();
    useMiddleware(p, { name: 'a', handler: async (v, n) => n(v + 1) });
    useMiddleware(p, { name: 'b', handler: async (v, n) => n(v + 2) });
    p.replace('a', { name: 'a', handler: async (v, n) => n(v + 100) });
    p.remove('b');
    expect(await p.run(0)).toBe(100);
  });

  it('rejects duplicate names', () => {
    const p = new Pipeline<number>();
    useMiddleware(p, { name: 'x', handler: async (v, n) => n(v) });
    expect(() => useMiddleware(p, { name: 'x', handler: async (v, n) => n(v) })).toThrow(/already/);
  });

  it('throws for unknown insertBefore target', () => {
    const p = new Pipeline<number>();
    expect(() => p.insertBefore('missing', { name: 'x', handler: async (v, n) => n(v) })).toThrow(
      /not found/,
    );
  });

  it('propagates middleware throw', async () => {
    const p = new Pipeline<number>();
    useMiddleware(p, {
      name: 'fail',
      handler: async () => {
        throw new Error('boom');
      },
    });
    await expect(p.run(0)).rejects.toThrow('boom');
  });

  it('async order preserved', async () => {
    const p = new Pipeline<string>();
    const order: string[] = [];
    useMiddleware(p, {
      name: 'a',
      handler: async (v, n) => {
        order.push('a-before');
        const r = await n(`${v}A`);
        order.push('a-after');
        return r;
      },
    });
    useMiddleware(p, {
      name: 'b',
      handler: async (v, n) => {
        order.push('b-before');
        const r = await n(`${v}B`);
        order.push('b-after');
        return r;
      },
    });
    expect(await p.run('')).toBe('AB');
    expect(order).toEqual(['a-before', 'b-before', 'b-after', 'a-after']);
  });

  describe('error boundary (L1-F)', () => {
    it('rethrows by default when middleware crashes', async () => {
      const p = new Pipeline<number>();
      useMiddleware(p, {
        name: 'crash',
        handler: async () => {
          throw new Error('boom');
        },
      });
      await expect(p.run(1)).rejects.toThrow('boom');
    });

    it('swallows when the handler returns "swallow"', async () => {
      const seen: { middleware: string; owner?: string }[] = [];
      const p = new Pipeline<number>();
      useMiddleware(p, {
        name: 'bad-plugin',
        owner: 'sneaky',
        handler: async () => {
          throw new Error('oops');
        },
      });
      p.setErrorHandler((ev) => {
        seen.push({
          middleware: ev.middleware,
          ...(ev.owner !== undefined ? { owner: ev.owner } : {}),
        });
        return 'swallow';
      });
      // Value going into the crashed middleware passes through unchanged.
      expect(await p.run(7)).toBe(7);
      expect(seen).toEqual([{ middleware: 'bad-plugin', owner: 'sneaky' }]);
    });

    it('rethrows when the handler returns "rethrow"', async () => {
      const p = new Pipeline<number>();
      useMiddleware(p, { name: 'good', handler: async (v, next) => next(v + 1) });
      useMiddleware(p, {
        name: 'kaboom',
        handler: async () => {
          throw new Error('x');
        },
      });
      p.setErrorHandler(() => 'rethrow');
      await expect(p.run(0)).rejects.toThrow('x');
    });

    it('after swallow, subsequent middleware is skipped (skip-the-broken-layer semantics)', async () => {
      const calls: string[] = [];
      const p = new Pipeline<number>();
      useMiddleware(p, {
        name: 'a',
        handler: async (v, next) => {
          calls.push('a');
          return next(v + 1);
        },
      });
      useMiddleware(p, {
        name: 'b',
        handler: async () => {
          calls.push('b');
          throw new Error('crash');
        },
      });
      useMiddleware(p, {
        name: 'c',
        handler: async (v, next) => {
          calls.push('c');
          return next(v * 10);
        },
      });
      p.setErrorHandler(() => 'swallow');
      // a runs (+1), b throws and is swallowed → run returns the value
      // flowing into b. c (downstream of b) never executes — the crashed
      // layer and everything below it are short-circuited.
      expect(await p.run(0)).toBe(1);
      expect(calls).toEqual(['a', 'b']);
    });

    it('after swallow, upstream middleware resumes its post-next() work while downstream is skipped', async () => {
      // Pins the full swallow semantics the docs describe: the crashed
      // middleware and everything downstream of it are skipped, but an
      // UPSTREAM middleware paused at `await next()` resumes normally and
      // observes the swallowed (pre-crash) value flowing back up.
      const calls: string[] = [];
      const p = new Pipeline<number>();
      useMiddleware(p, {
        name: 'upstream',
        handler: async (v, next) => {
          calls.push('upstream:before');
          const out = await next(v + 1); // descends into 'crash'
          calls.push(`upstream:after(${out})`); // must still run after swallow
          return out + 100;
        },
      });
      useMiddleware(p, {
        name: 'crash',
        handler: async () => {
          calls.push('crash');
          throw new Error('boom');
        },
      });
      useMiddleware(p, {
        name: 'downstream',
        handler: async (v, next) => {
          calls.push('downstream'); // must NEVER run
          return next(v);
        },
      });
      p.setErrorHandler(() => 'swallow');
      // run(0): upstream sees 0, passes 1 into crash; crash throws and is
      // swallowed so `next()` resolves to 1; upstream's post-next() runs and
      // adds 100 → 101. downstream never executes.
      const result = await p.run(0);
      expect(result).toBe(101);
      expect(calls).toEqual(['upstream:before', 'crash', 'upstream:after(1)']);
    });

    it('swallow path emits a structured warning when a logger is set (P2 #7)', async () => {
      const warnings: { msg: string; ctx?: unknown }[] = [];
      const p = new Pipeline<number>();
      useMiddleware(p, {
        name: 'bad-plugin',
        owner: 'third-party',
        handler: async () => {
          throw new Error('plugin blew up');
        },
      });
      p.setErrorHandler(() => 'swallow');
      p.setLogger({
        warn: (msg, ctx) => {
          warnings.push({ msg, ctx });
        },
      });
      await p.run(42);
      expect(warnings).toHaveLength(1);
      const warning = warnings.at(0);
      expect(warning?.msg).toBe('pipeline.error');
      expect(warning?.ctx).toMatchObject({
        middleware: 'bad-plugin',
        owner: 'third-party',
        error: 'plugin blew up',
      });
    });

    it('swallow path is silent when no logger is set (backward compatible)', async () => {
      const p = new Pipeline<number>();
      useMiddleware(p, {
        name: 'silent-crash',
        handler: async () => {
          throw new Error('no logger');
        },
      });
      p.setErrorHandler(() => 'swallow');
      // No setLogger call — the swallow path must still work, just silently.
      // (Pre-P2-#7 behavior, preserved for callers that haven't wired a logger.)
      expect(await p.run(7)).toBe(7);
    });

    it('rethrow path does NOT log (only swallow logs)', async () => {
      const warnings: { msg: string; ctx?: unknown }[] = [];
      const p = new Pipeline<number>();
      useMiddleware(p, {
        name: 'crash',
        handler: async () => {
          throw new Error('rethrown');
        },
      });
      p.setErrorHandler(() => 'rethrow');
      p.setLogger({
        warn: (msg, ctx) => {
          warnings.push({ msg, ctx });
        },
      });
      await expect(p.run(0)).rejects.toThrow('rethrown');
      expect(warnings).toHaveLength(0);
    });

    it('does not re-invoke errorHandler for upstream middleware when downstream error rethrows', async () => {
      const p = new Pipeline<number>();
      const offenders: string[] = [];
      useMiddleware(p, {
        name: 'upstream',
        handler: async (v, next) => next(v),
      });
      useMiddleware(p, {
        name: 'crash',
        handler: async () => {
          throw new Error('downstream crash');
        },
      });
      p.setErrorHandler((ev) => {
        offenders.push(ev.middleware);
        return 'rethrow';
      });

      await expect(p.run(1)).rejects.toThrow('downstream crash');
      expect(offenders).toEqual(['crash']);
    });
  });

  describe('asReadonly', () => {
    it('returns a frozen view with size + list + run methods', async () => {
      const p = new Pipeline<number>();
      useMiddleware(p, { name: 'plus-one', handler: async (v, next) => next(v + 1) });
      const view = p.asReadonly();
      expect(view.size).toBe(1);
      expect(view.list()).toEqual(['plus-one']);
      expect(Object.isFrozen(view)).toBe(true);
      expect(await view.run(0)).toBe(1);
    });

    it('size on the view reflects subsequent mutations', () => {
      const p = new Pipeline<number>();
      const view = p.asReadonly();
      expect(view.size).toBe(0);
      useMiddleware(p, { name: 'm', handler: async (v, next) => next(v) });
      expect(view.size).toBe(1);
    });

    it('list snapshot from the view is frozen', () => {
      const p = new Pipeline<number>();
      useMiddleware(p, { name: 'm', handler: async (v, next) => next(v) });
      const snap = p.asReadonly().list();
      expect(Object.isFrozen(snap)).toBe(true);
    });
  });
});
