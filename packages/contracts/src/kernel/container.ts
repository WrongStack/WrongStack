import { ERROR_CODES, WrongStackError } from '../types/errors.js';

/**
 * Container — dependency injection with explicit bind / override / decorate.
 *
 * Invariants:
 *   bind()     — throws if token already bound
 *   override() — throws if nothing to replace
 *   decorate() — stacks; cached value cleared on register
 */

export type Token<T> = symbol & { readonly __type?: T };
export type Factory<T> = (c: Container) => T;
export type Decorator<T> = (inner: T, c: Container) => T;

interface Entry<T = unknown> {
  factory: Factory<T>;
  singleton: boolean;
  decorators: Decorator<T>[];
  cache?: T | undefined;
  /**
   * True once a singleton value has been built and stored in `cache`.
   * Tracked separately from `cache !== undefined` so a singleton factory
   * that legitimately resolves to `undefined` (or any falsy value) is still
   * memoized rather than re-run on every resolve().
   */
  hasCache: boolean;
  owner: string;
}

export interface BindOptions {
  singleton?: boolean | undefined;
  owner?: string | undefined;
}

export class Container {
  private readonly entries = new Map<symbol, Entry>();
  /**
   * Tokens currently mid-resolve. Tracked so we can detect circular
   * dependencies (A → B → A) and throw a structured error instead of
   * overflowing the call stack with "Maximum call stack size exceeded".
   *
   * Not a memoization cache — the per-entry `cache` field is the source
   * of truth for "have I built this before?". This set only lives for
   * the duration of a single resolve call.
   */
  private readonly resolving = new Set<symbol>();

  bind<T>(token: Token<T>, factory: Factory<T>, opts: BindOptions = {}): void {
    if (this.entries.has(token)) {
      throw new WrongStackError({
        message: `Container: token "${token.description ?? 'unknown'}" already bound`,
        code: ERROR_CODES.CONTAINER_TOKEN_ALREADY_BOUND,
        subsystem: 'container',
        context: { token: token.description },
      });
    }
    this.entries.set(token, {
      factory: factory as Factory<unknown>,
      singleton: opts.singleton ?? true,
      decorators: [],
      hasCache: false,
      owner: opts.owner ?? 'core',
    });
  }

  override<T>(token: Token<T>, factory: Factory<T>, opts: BindOptions = {}): void {
    const existing = this.entries.get(token);
    if (!existing) {
      throw new WrongStackError({
        message: `Container: cannot override "${token.description ?? 'unknown'}" — not bound`,
        code: ERROR_CODES.CONTAINER_TOKEN_NOT_BOUND,
        subsystem: 'container',
        context: { token: token.description },
      });
    }
    this.entries.set(token, {
      factory: factory as Factory<unknown>,
      singleton: opts.singleton ?? existing.singleton,
      decorators: existing.decorators,
      hasCache: false,
      owner: opts.owner ?? existing.owner,
    });
  }

  decorate<T>(token: Token<T>, decorator: Decorator<T>, owner = 'core'): void {
    const existing = this.entries.get(token);
    if (!existing) {
      throw new WrongStackError({
        message: `Container: cannot decorate "${token.description ?? 'unknown'}" — not bound`,
        code: ERROR_CODES.CONTAINER_TOKEN_NOT_BOUND,
        subsystem: 'container',
        context: { token: token.description },
      });
    }
    existing.decorators.push(decorator as Decorator<unknown>);
    existing.cache = undefined;
    existing.hasCache = false;
    existing.owner = `${existing.owner}+${owner}`;
  }

  resolve<T>(token: Token<T>): T {
    const entry = this.entries.get(token);
    if (!entry) {
      throw new WrongStackError({
        message: `Container: token "${token.description ?? 'unknown'}" not bound`,
        code: ERROR_CODES.CONTAINER_TOKEN_NOT_BOUND,
        subsystem: 'container',
        context: { token: token.description },
      });
    }
    if (entry.singleton && entry.hasCache) {
      return entry.cache as T;
    }
    if (this.resolving.has(token)) {
      const cycle = this.describeCycle(token);
      throw new WrongStackError({
        message: `Container: circular dependency detected — ${cycle}`,
        code: ERROR_CODES.CONTAINER_CIRCULAR_DEPENDENCY,
        subsystem: 'container',
        context: { token: token.description, cycle },
      });
    }
    this.resolving.add(token);
    try {
      let value: unknown = entry.factory(this);
      for (const d of entry.decorators) {
        value = d(value, this);
      }
      if (entry.singleton) {
        entry.cache = value;
        entry.hasCache = true;
      }
      return value as T;
    } finally {
      this.resolving.delete(token);
    }
  }

  /**
   * Build a human-readable description of the dependency cycle that
   * caused the resolution to re-enter. Lists the tokens in the order
   * they were entered, then appends the re-entered token to close the
   * loop. Falls back to a generic message if the resolving set is
   * somehow empty (shouldn't happen, but defensive).
   */
  private describeCycle(reentry: symbol): string {
    const descs: string[] = [];
    const seen = new Set<symbol>();
    for (const t of this.resolving) {
      if (seen.has(t)) continue;
      seen.add(t);
      descs.push(t.description ?? 'unknown');
    }
    descs.push(reentry.description ?? 'unknown');
    return descs.join(' → ');
  }

  has<T>(token: Token<T>): boolean {
    return this.entries.has(token);
  }

  /**
   * Resolve a token if it is bound, otherwise return undefined.
   * Unlike `resolve()`, this does not throw if the token is unbound.
   *
   * Single map lookup — `has()` + `resolve()` would walk the entries
   * map twice. The bound check is folded into the resolve path so a
   * non-existent token can never enter the `resolving` cycle-detection
   * set.
   */
  safeResolve<T>(token: Token<T>): T | undefined {
    if (!this.entries.has(token)) return undefined;
    return this.resolve(token);
  }

  ownerOf<T>(token: Token<T>): string | undefined {
    return this.entries.get(token)?.owner;
  }

  /**
   * Remove a token's binding (along with any decorators stacked on it).
   * Returns true if the token existed. Use this to withdraw temporary
   * bindings installed by a short-lived run or plugin — without it, the
   * entry persists in the map forever.
   */
  unbind<T>(token: Token<T>): boolean {
    return this.entries.delete(token);
  }

  /**
   * Drop every binding. Intended for tests and short-lived CLI invocations
   * that rebuild the container from scratch. Production code should prefer
   * `unbind` on the specific tokens it owns.
   */
  clear(): void {
    this.entries.clear();
  }

  list(): Array<{ token: symbol; owner: string }> {
    return Array.from(this.entries.entries()).map(([token, entry]) => ({
      token,
      owner: entry.owner,
    }));
  }

  /**
   * Inspect a binding's full shape, including decorator count and whether
   * a singleton value is cached. Returns null if the token is unbound.
   * Decorator and factory function references are not exposed — only counts
   * and metadata, to keep internal state hidden.
   */
  inspect<T>(token: Token<T>): {
    owner: string;
    singleton: boolean;
    decoratorCount: number;
    cached: boolean;
  } | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    return {
      owner: entry.owner,
      singleton: entry.singleton,
      decoratorCount: entry.decorators.length,
      cached: entry.hasCache,
    };
  }
}
