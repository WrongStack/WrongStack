import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * PR 1 of Issue #30 (webui-server 8-PR refactor):
 * characterize the console-backed `Logger` shim.
 *
 * The shim's `consoleLogger` object captures the
 * `console.*` methods at module evaluation time (e.g.
 * `info(msg) { console.log(...) }`). To make the shim's
 * `console.*` calls observable, the spies must be in
 * place BEFORE the module is imported. We do that by
 * spying on `console.*` first, then dynamically importing
 * the module under test.
 *
 * What the tests pin:
 *   1. JSON shape: each level produces a single-line
 *      `JSON.stringify(...)` of `{ level, event:
 *      'webui.autophase', message, timestamp }`.
 *   2. Level routing: `error`/`warn` go to `console.error`
 *      /`console.warn`; `info`/`debug`/`trace` go to
 *      `console.log`/`console.debug`/`console.debug`
 *      (the shim collapses `trace` to `console.debug`).
 *   3. `child()` returns the same logger (no binding
 *      chain).
 *   4. `level` is `'debug'`.
 */

// Spy FIRST (before importing the module under test).
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

const { consoleLogger } = await import('../../src/webui-server/logger-shim.js');

describe('consoleLogger (PR 1 of #30)', () => {
  beforeEach(() => {
    errorSpy.mockClear();
    warnSpy.mockClear();
    logSpy.mockClear();
    debugSpy.mockClear();
  });

  afterAll(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('exposes level: "debug"', () => {
    expect(consoleLogger.level).toBe('debug');
  });

  it('error() routes to console.error with structured JSON', () => {
    consoleLogger.error('something broke');
    expect(errorSpy).toHaveBeenCalledOnce();
    const arg = errorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.level).toBe('error');
    expect(parsed.event).toBe('webui.autophase');
    expect(parsed.message).toBe('something broke');
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('warn() routes to console.warn', () => {
    consoleLogger.warn('careful');
    expect(warnSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(parsed.level).toBe('warn');
  });

  it('info() routes to console.log', () => {
    consoleLogger.info('hello');
    expect(logSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.level).toBe('info');
  });

  it('debug() routes to console.debug', () => {
    consoleLogger.debug('details');
    expect(debugSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(debugSpy.mock.calls[0][0]);
    expect(parsed.level).toBe('debug');
  });

  it('trace() collapses to console.debug (pre-refactor behavior pinned)', () => {
    consoleLogger.trace('verbose');
    expect(debugSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(debugSpy.mock.calls[0][0]);
    expect(parsed.level).toBe('trace');
  });

  it('child() returns the same logger (no binding chain)', () => {
    const child = consoleLogger.child({ requestId: 'abc' });
    expect(child).toBe(consoleLogger);
  });
});
