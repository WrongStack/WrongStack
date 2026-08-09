import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR 1 of Issue #30 (webui-server 8-PR refactor):
 * characterize the console-backed `Logger` shim.
 *
 * The shim calls the `console.*` methods at call time (e.g.
 * `info(msg) { console.log(...) }`), so the spies are installed
 * in `beforeEach`. This package's vitest config sets
 * `restoreMocks: true`, which restores all mocks after each
 * test — spies installed at module scope would be restored to
 * the real `console.*` after the first test and observe
 * nothing.
 *
 * What the tests pin:
 *   1. JSON shape: each level produces a single-line
 *      `JSON.stringify(...)` of `{ level, event:
 *      'webui.goal', message, timestamp }`.
 *   2. Level routing: `error`/`warn` go to `console.error`
 *      /`console.warn`; `info`/`debug`/`trace` go to
 *      `console.log`/`console.debug`/`console.debug`
 *      (the shim collapses `trace` to `console.debug`).
 *   3. `child()` returns the same logger (no binding
 *      chain).
 *   4. `level` is `'debug'`.
 */

import { consoleLogger } from '../../src/webui-server/logger-shim.js';

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

describe('consoleLogger (PR 1 of #30)', () => {
  beforeEach(() => {
    // Root config does not set restoreMocks: true, so spies persist across
    // tests within the worker. Restore first, then install fresh spies —
    // otherwise re-spying console.debug wraps the previous spy and call
    // counts accumulate across tests.
    vi.restoreAllMocks();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('exposes level: "debug"', () => {
    expect(consoleLogger.level).toBe('debug');
  });

  it('error() routes to console.error with structured JSON', () => {
    consoleLogger.error('something broke');
    expect(errorSpy).toHaveBeenCalledOnce();
    const arg = errorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.level).toBe('error');
    expect(parsed.event).toBe('webui.goal');
    expect(parsed.message).toBe('something broke');
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('warn() routes to console.warn', () => {
    consoleLogger.warn('careful');
    expect(warnSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0]);
    expect(parsed.level).toBe('warn');
  });

  it('info() routes to console.log', () => {
    consoleLogger.info('hello');
    expect(logSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0]);
    expect(parsed.level).toBe('info');
  });

  it('debug() routes to console.debug', () => {
    consoleLogger.debug('details');
    expect(debugSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(debugSpy.mock.calls[0]?.[0]);
    expect(parsed.level).toBe('debug');
  });

  it('trace() collapses to console.debug (pre-refactor behavior pinned)', () => {
    consoleLogger.trace('verbose');
    expect(debugSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(debugSpy.mock.calls[0]?.[0]);
    expect(parsed.level).toBe('trace');
  });

  it('child() returns the same logger (no binding chain)', () => {
    const child = consoleLogger.child({ requestId: 'abc' });
    expect(child).toBe(consoleLogger);
  });
});
