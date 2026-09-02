/**
 * Pipeline — Koa-style middleware chain with named middleware
 * and position-aware insertion. Generic over input type T.
 */

import { WrongStackError, ERROR_CODES } from '../types/errors.js';

export type NextFn<T> = (value: T) => Promise<T>;
export type MiddlewareHandler<T> = (value: T, next: NextFn<T>) => Promise<T>;

/**
 * Called when a middleware crashes (throws or rejects). Used by the
 * Pipeline's error boundary to log the offender without aborting the run.
 *
 * Return `'rethrow'` to propagate the error (default for core middleware),
 * or `'swallow'` to abort descent into the crashing middleware: its caller's
 * `await next()` resolves with the value that was about to flow into the
 * crashed middleware. The crashed middleware AND every middleware after it in
 * the chain are skipped (they never run); UPSTREAM middleware, already paused
 * at their own `await next()`, resume their post-`next()` work normally. It
 * does NOT continue at the next sibling middleware. Plugin middleware should
 * usually be swallowed so one bad plugin can't kill an agent run.
 */
export type PipelineErrorPolicy = 'rethrow' | 'swallow';

export interface PipelineErrorEvent {
  middleware: string;
  owner?: string | undefined;
  err: unknown;
}

export type PipelineErrorHandler = (
  ev: PipelineErrorEvent,
) => PipelineErrorPolicy | Promise<PipelineErrorPolicy>;

export interface Middleware<T> {
  name: string;
  handler: MiddlewareHandler<T>;
  owner?: string | undefined;
}

export interface PipelineOptions {
  /** When true and the target middleware is not found, operations silently no-op instead of throwing. */
  optional?: boolean | undefined;
}

/**
 * Read-only view of a pipeline. Returned to consumers (plugins, hooks)
 * so they can inspect but not mutate the chain.
 */
export interface ReadonlyPipeline<T> {
  readonly size: number;
  list(): readonly string[];
  run(input: T): Promise<T>;
}

export class Pipeline<T> {
  private readonly chain: Middleware<T>[] = [];
  private errorHandler?: PipelineErrorHandler | undefined;
  /**
   * Optional operational logger. When set, the `swallow` error-boundary path
   * emits a structured warning so a swallowed middleware crash is never
   * completely silent (P2 #7, before-release.md). Without a logger, the
   * swallow path still works but the crash is invisible — host code should
   * always wire one.
   */
  private logger?: { warn: (msg: string, ctx?: unknown) => void | undefined } | undefined;

  /**
   * Install an error boundary. When a middleware throws or rejects, the
   * handler is called and decides whether to swallow (continue with the
   * pre-handler value) or rethrow. Without a handler, errors propagate.
   *
   * Wire one per pipeline at boot — the host CLI typically installs a
   * single boundary that logs to the operational log and emits a
   * `pipeline.error` event for /diag.
   */
  setErrorHandler(handler: PipelineErrorHandler | undefined): this {
    this.errorHandler = handler;
    return this;
  }

  /**
   * Set the operational logger used by the swallow error-boundary path.
   * Without this, a swallowed middleware crash is completely silent.
   */
  setLogger(logger: { warn: (msg: string, ctx?: unknown) => void | undefined } | undefined): this {
    this.logger = logger;
    return this;
  }

  use(mw: Middleware<T> | Middleware<unknown>): this {
    this.ensureUnique(mw.name);
    this.chain.push(mw as Middleware<T>);
    return this;
  }

  prepend(mw: Middleware<T>): this {
    this.ensureUnique(mw.name);
    this.chain.unshift(mw);
    return this;
  }

  /**
   * Insert middleware at an explicit index. Out-of-range indices are clamped.
   * Use this when insertBefore/insertAfter are insufficient (e.g. to place
   * a middleware at a known position regardless of named targets).
   */
  insertAt(index: number, mw: Middleware<T>): this {
    this.ensureUnique(mw.name);
    const idx = Math.max(0, Math.min(index, this.chain.length));
    this.chain.splice(idx, 0, mw);
    return this;
  }

  /**
   * Insert mw immediately before the first occurrence of target.
   * If called multiple times with the same target, each call inserts
   * before the target's current position — so after insertBefore('B', X)
   * then insertBefore('B', Y), the order is Y → X → B.
   */
  insertBefore(target: string, mw: Middleware<T>, opts?: PipelineOptions): this {
    this.ensureUnique(mw.name);
    const idx = this.indexOf(target, opts?.optional);
    if (idx === -1) return this;
    this.chain.splice(idx, 0, mw);
    return this;
  }

  /**
   * Insert mw immediately after the first occurrence of target.
   * If called multiple times with the same target, each call inserts
   * after the target's current position — so after insertAfter('B', X)
   * then insertAfter('B', Y), the order is B → X → Y.
   */
  insertAfter(target: string, mw: Middleware<T>, opts?: PipelineOptions): this {
    this.ensureUnique(mw.name);
    const idx = this.indexOf(target, opts?.optional);
    if (idx === -1) return this;
    this.chain.splice(idx + 1, 0, mw);
    return this;
  }

  replace(target: string, mw: Middleware<T>, opts?: PipelineOptions): this {
    if (mw.name !== target) this.ensureUnique(mw.name);
    const idx = this.indexOf(target, opts?.optional);
    if (idx === -1) return this;
    this.chain[idx] = mw;
    return this;
  }

  remove(name: string, opts?: PipelineOptions): this {
    const idx = this.indexOf(name, opts?.optional);
    if (idx === -1) return this;
    this.chain.splice(idx, 1);
    return this;
  }

  list(): readonly string[] {
    return this.chain.map((m) => m.name);
  }

  size(): number {
    return this.chain.length;
  }

  /** Return a read-only view suitable for passing to plugins. */
  asReadonly(): ReadonlyPipeline<T> {
    // The returned object's methods close over `this`, so it always sees the
    // live chain. `list()` freezes its result so plugin code can't mutate
    // the chain names; subsequent calls produce fresh frozen snapshots.
    const self = this;
    const view: ReadonlyPipeline<T> = Object.freeze({
      get size(): number {
        return self.chain.length;
      },
      list(): readonly string[] {
        return Object.freeze(self.chain.map((m) => m.name));
      },
      run(input: T): Promise<T> {
        return self.run(input);
      },
    });
    return view;
  }

  async run(input: T): Promise<T> {
    let index = -1;
    const chain = this.chain;
    const errorHandler = this.errorHandler;

    const dispatch = async (i: number, value: T): Promise<T> => {
      if (i <= index) {
        const offender = chain[index]?.name;
        throw new WrongStackError({
          message: `Pipeline: next() called multiple times in "${offender}"`,
          code: ERROR_CODES.VALIDATION_ERROR,
          subsystem: 'container',
          context: { middleware: offender },
        });
      }
      index = i;
      const mw = chain[i];
      if (!mw) return value;
      try {
        return await mw.handler(value, (v) => dispatch(i + 1, v));
      } catch (err) {
        if (!errorHandler) throw err;
        const policy = await errorHandler({ middleware: mw.name, owner: mw.owner, err });
        if (policy === 'rethrow') throw err;
        // Swallow: resolve THIS dispatch with the value that was about to flow
        // into the crashed middleware. Because we return instead of recursing,
        // the crashed middleware and everything downstream of it never run; the
        // upstream caller's `await next()` resolves with `value` and its
        // post-next() logic continues. Net effect: the broken layer and the
        // rest of the chain below it are short-circuited, while already-entered
        // upstream layers unwind normally.
        // P2 #7 (before-release.md): emit a structured warning so a swallowed
        // crash is never completely silent. Plugin authors debugging a
        // short-circuited middleware would otherwise have no signal.
        this.logger?.warn('pipeline.error', {
          middleware: mw.name,
          owner: mw.owner,
          error: err instanceof Error ? err.message : String(err),
        });
        return value;
      }
    };

    return dispatch(0, input);
  }

  private indexOf(name: string, optional = false): number {
    const idx = this.chain.findIndex((m) => m.name === name);
    if (idx === -1 && !optional) {
      throw new WrongStackError({
        message: `Pipeline: middleware "${name}" not found`,
        code: ERROR_CODES.REGISTRY_NOT_FOUND,
        subsystem: 'container',
        context: { middleware: name },
      });
    }
    return idx;
  }

  private ensureUnique(name: string): void {
    if (this.chain.some((m) => m.name === name)) {
      throw new WrongStackError({
        message: `Pipeline: middleware "${name}" already registered`,
        code: ERROR_CODES.REGISTRY_DUPLICATE,
        subsystem: 'container',
        context: { middleware: name },
      });
    }
  }
}
