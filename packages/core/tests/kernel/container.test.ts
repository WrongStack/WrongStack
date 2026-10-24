import { Container, type Token } from '@wrongstack/contracts/kernel/container';
import { describe, expect, it } from 'vitest';

interface Logger {
  msg: string;
}

const LOGGER: Token<Logger> = Symbol('Logger') as Token<Logger>;
const COUNTER: Token<{ count: number }> = Symbol('Counter') as Token<{ count: number }>;

describe('Container', () => {
  it('binds and resolves', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'hi' }));
    expect(c.resolve(LOGGER).msg).toBe('hi');
  });

  it('rejects double bind', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'a' }));
    expect(() => c.bind(LOGGER, () => ({ msg: 'b' }))).toThrow(/already bound/);
  });

  it('rejects override of unbound', () => {
    const c = new Container();
    expect(() => c.override(LOGGER, () => ({ msg: 'a' }))).toThrow(/not bound/);
  });

  it('override replaces and clears cache', () => {
    const c = new Container();
    let count = 0;
    c.bind(LOGGER, () => ({ msg: `v${++count}` }));
    expect(c.resolve(LOGGER).msg).toBe('v1');
    expect(c.resolve(LOGGER).msg).toBe('v1'); // cached
    c.override(LOGGER, () => ({ msg: 'new' }));
    expect(c.resolve(LOGGER).msg).toBe('new');
  });

  it('singleton: default true', () => {
    const c = new Container();
    let count = 0;
    c.bind(COUNTER, () => ({ count: ++count }));
    expect(c.resolve(COUNTER)).toBe(c.resolve(COUNTER));
  });

  it('singleton: false makes new each time', () => {
    const c = new Container();
    let count = 0;
    c.bind(COUNTER, () => ({ count: ++count }), { singleton: false });
    expect(c.resolve(COUNTER)).not.toBe(c.resolve(COUNTER));
  });

  it('singleton: caches an undefined-returning factory, running it exactly once', () => {
    // Regression guard: the old cache sentinel (`cache !== undefined`) would
    // treat an undefined singleton value as "not yet built" and re-run the
    // factory on every resolve(). The hasCache flag must memoize undefined.
    const UNDEF: Token<undefined> = Symbol('Undef') as Token<undefined>;
    const c = new Container();
    let calls = 0;
    c.bind(UNDEF, () => {
      calls++;
      return undefined;
    });
    expect(c.resolve(UNDEF)).toBeUndefined();
    expect(c.resolve(UNDEF)).toBeUndefined();
    expect(c.resolve(UNDEF)).toBeUndefined();
    expect(calls).toBe(1);
    // inspect() must report the binding as cached even though the value is undefined.
    expect(c.inspect(UNDEF)?.cached).toBe(true);
  });

  it('decorate wraps and stacks', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'base' }));
    c.decorate(LOGGER, (inner) => ({ msg: `(${inner.msg})` }));
    c.decorate(LOGGER, (inner) => ({ msg: `[${inner.msg}]` }));
    expect(c.resolve(LOGGER).msg).toBe('[(base)]');
  });

  it('rejects decorate of unbound', () => {
    const c = new Container();
    expect(() => c.decorate(LOGGER, (i) => i)).toThrow(/not bound/);
  });

  it('resolve of unbound throws with description', () => {
    const c = new Container();
    expect(() => c.resolve(LOGGER)).toThrow(/Logger/);
  });

  it('has() reports binding state', () => {
    const c = new Container();
    expect(c.has(LOGGER)).toBe(false);
    c.bind(LOGGER, () => ({ msg: 'x' }));
    expect(c.has(LOGGER)).toBe(true);
  });

  it('ownerOf tracks owner with decoration', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'x' }), { owner: 'core' });
    c.decorate(LOGGER, (i) => i, 'plugin-a');
    expect(c.ownerOf(LOGGER)).toMatch(/core\+plugin-a/);
  });

  it('unbind removes a binding and returns true; false for unknown', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'x' }));
    expect(c.has(LOGGER)).toBe(true);
    expect(c.unbind(LOGGER)).toBe(true);
    expect(c.has(LOGGER)).toBe(false);
    expect(c.unbind(LOGGER)).toBe(false);
    expect(() => c.resolve(LOGGER)).toThrow(/not bound/);
  });

  it('unbind discards decorators stacked on the token', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'base' }));
    c.decorate(LOGGER, (i) => ({ msg: `${i.msg}+dec` }));
    expect(c.resolve(LOGGER).msg).toBe('base+dec');
    c.unbind(LOGGER);
    // Re-bind: should NOT inherit the previous decorator chain.
    c.bind(LOGGER, () => ({ msg: 'fresh' }));
    expect(c.resolve(LOGGER).msg).toBe('fresh');
  });

  it('clear drops every binding', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'a' }));
    c.bind(COUNTER, () => ({ count: 0 }));
    expect(c.list()).toHaveLength(2);
    c.clear();
    expect(c.list()).toHaveLength(0);
    expect(c.has(LOGGER)).toBe(false);
  });

  it('inspect returns decorator count + cache state', () => {
    const c = new Container();
    c.bind(LOGGER, () => ({ msg: 'x' }), { owner: 'core' });
    expect(c.inspect(LOGGER)).toEqual({
      owner: 'core',
      singleton: true,
      decoratorCount: 0,
      cached: false,
    });
    c.decorate(LOGGER, (i) => i, 'plug');
    c.resolve(LOGGER);
    const after = c.inspect(LOGGER)!;
    expect(after.decoratorCount).toBe(1);
    expect(after.cached).toBe(true);
    expect(c.inspect(COUNTER)).toBeNull();
  });

  it('throws a structured error on a 2-cycle (A → B → A), not a stack overflow', () => {
    const A: Token<number> = Symbol('A') as Token<number>;
    const B: Token<number> = Symbol('B') as Token<number>;
    const c = new Container();
    c.bind(A, (cc) => cc.resolve(B) + 1);
    c.bind(B, (cc) => cc.resolve(A) + 1);
    let err: unknown;
    try {
      c.resolve(A);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/circular dependency/);
    expect(msg).toContain('A');
    expect(msg).toContain('B');
  });

  it('throws on a self-cycle (A → A)', () => {
    const A: Token<number> = Symbol('A') as Token<number>;
    const c = new Container();
    c.bind(A, (cc) => cc.resolve(A) + 1);
    expect(() => c.resolve(A)).toThrow(/circular dependency/);
  });

  it('throws on a 3-cycle and lists every token in the path', () => {
    const A: Token<number> = Symbol('A') as Token<number>;
    const B: Token<number> = Symbol('B') as Token<number>;
    const C: Token<number> = Symbol('C') as Token<number>;
    const c = new Container();
    c.bind(A, (cc) => cc.resolve(B) + 1);
    c.bind(B, (cc) => cc.resolve(C) + 1);
    c.bind(C, (cc) => cc.resolve(A) + 1);
    let err: unknown;
    try {
      c.resolve(A);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/A.*B.*C.*A/s);
  });

  it('clears the resolving set after a successful resolve, so the same token can be re-resolved', () => {
    // Regression guard: if the finally-block didn't fire, the second
    // resolve would see the token still in `resolving` and throw
    // CIRCULAR_DEPENDENCY. We use singleton:false so the factory
    // actually runs twice — otherwise the singleton cache would mask
    // the bug.
    const A: Token<number> = Symbol('A') as Token<number>;
    const c = new Container();
    let n = 0;
    c.bind(A, () => ++n, { singleton: false });
    expect(c.resolve(A)).toBe(1);
    expect(c.resolve(A)).toBe(2);
  });

  it('clears the resolving set after a throwing factory, so the token can be rebound and retried', () => {
    const A: Token<number> = Symbol('A') as Token<number>;
    const c = new Container();
    c.bind(A, () => {
      throw new Error('factory failed');
    });
    expect(() => c.resolve(A)).toThrow('factory failed');
    // If the resolving set leaked, this would throw CIRCULAR_DEPENDENCY
    // instead of "factory failed" again.
    expect(() => c.resolve(A)).toThrow('factory failed');
  });

  it('safeResolve returns undefined for unbound tokens without polluting the resolving set', () => {
    // Regression guard: safeResolve must short-circuit BEFORE entering
    // resolve(), so a missing token can't poison cycle detection on a
    // subsequent resolve of a different token that depends on it.
    const A: Token<number> = Symbol('A') as Token<number>;
    const B: Token<number> = Symbol('B') as Token<number>;
    const c = new Container();
    c.bind(B, (cx) => (cx.safeResolve(A) ?? 42) + 1);
    expect(c.resolve(B)).toBe(43);
  });
});
