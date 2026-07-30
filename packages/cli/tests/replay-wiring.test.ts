import { TOKENS } from '@wrongstack/core/kernel';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runProviderWithRetry: vi.fn(),
  logOptions: [] as unknown[],
  runnerArgs: [] as unknown[],
}));

vi.mock('@wrongstack/core/agent', () => ({
  runProviderWithRetry: mocks.runProviderWithRetry,
}));

vi.mock('@wrongstack/core/storage', () => ({
  ReplayLogStore: class {
    constructor(options: unknown) {
      mocks.logOptions.push(options);
    }
  },
}));

vi.mock('@wrongstack/core/replay', () => ({
  ReplayProviderRunner: class {
    constructor(inner: unknown, options: unknown) {
      mocks.runnerArgs.push([inner, options]);
    }
  },
}));

import { bindReplayToContainer } from '../src/wiring/replay.js';

function container(initial?: unknown) {
  const bindings = new Map<symbol, () => unknown>();
  if (initial) bindings.set(TOKENS.ProviderRunner, () => initial);
  return {
    has: vi.fn((token: symbol) => bindings.has(token)),
    bind: vi.fn((token: symbol, factory: () => unknown) => {
      bindings.set(token, factory);
    }),
    resolve: vi.fn((token: symbol) => {
      const factory = bindings.get(token);
      if (!factory) throw new Error('missing binding');
      return factory();
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logOptions.length = 0;
  mocks.runnerArgs.length = 0;
});

describe('bindReplayToContainer', () => {
  it('installs a default provider runner before wrapping an empty container', async () => {
    const target = container();
    const response = { text: 'provider response' };
    mocks.runProviderWithRetry.mockResolvedValue(response);

    bindReplayToContainer({
      container: target as never,
      wpaths: { projectSessions: 'C:/sessions' } as never,
      sessionId: 'session-1',
      mode: 'record',
    });

    expect(target.bind).toHaveBeenCalledTimes(2);
    const inner = (mocks.runnerArgs[0] as [unknown, Record<string, unknown>])[0] as {
      run(options: unknown): Promise<unknown>;
    };
    await expect(inner.run({ model: 'test' })).resolves.toBe(response);
    expect(mocks.runProviderWithRetry).toHaveBeenCalledWith({ model: 'test' });
    expect(mocks.logOptions).toEqual([{ dir: 'C:/sessions' }]);
    expect((mocks.runnerArgs[0] as [unknown, Record<string, unknown>])[1]).toEqual({
      log: expect.anything(),
      sessionId: 'session-1',
      mode: 'record',
      logger: undefined,
    });
    expect(target.resolve(TOKENS.ProviderRunner)).toBeInstanceOf(
      (await import('@wrongstack/core/replay')).ReplayProviderRunner,
    );
  });

  it('wraps an existing runner and adapts optional logger methods', () => {
    const inner = { run: vi.fn() };
    const debug = vi.fn();
    const warn = vi.fn();
    const target = container(inner);

    bindReplayToContainer({
      container: target as never,
      wpaths: { projectSessions: 'C:/sessions' } as never,
      sessionId: 'session-2',
      mode: 'auto',
      logger: { debug, warn } as never,
    });

    expect(target.bind).toHaveBeenCalledOnce();
    const [capturedInner, options] = mocks.runnerArgs[0] as [
      unknown,
      { logger: { debug(message: string): void; warn(message: string): void } },
    ];
    expect(capturedInner).toBe(inner);
    options.logger.debug('debug');
    options.logger.warn('warn');
    expect(debug).toHaveBeenCalledWith('debug');
    expect(warn).toHaveBeenCalledWith('warn');
    expect(target.resolve(TOKENS.ProviderRunner)).toBeDefined();
  });

  it('tolerates loggers without debug or warn implementations', () => {
    const target = container({ run: vi.fn() });

    bindReplayToContainer({
      container: target as never,
      wpaths: { projectSessions: 'C:/sessions' } as never,
      sessionId: 'session-3',
      mode: 'replay',
      logger: {} as never,
    });

    const options = (
      mocks.runnerArgs[0] as [
        unknown,
        { logger: { debug: (message: string) => void; warn: (message: string) => void } },
      ]
    )[1];
    expect(() => options.logger.debug('debug')).not.toThrow();
    expect(() => options.logger.warn('warn')).not.toThrow();
  });
});
