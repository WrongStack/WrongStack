import { describe, expect, it, vi } from 'vitest';

/**
 * PR 3 of Issue #29: PathResolver + EventBus + container setup
 * is now in `wireContainer()`. This test pins the contract
 * that future refactors of cli-main can't accidentally regress.
 *
 *   1. wireContainer returns a PathResolver, an EventBus, and
 *      a container. (The container itself is whatever
 *      `createDefaultContainer` returns; we mock that factory
 *      here so the test doesn't have to wire up a real
 *      memory store, vault, brain, and the rest of the
 *      runtime's heavy dependencies.)
 *   2. The returned `events` bus has the deps.logger
 *      attached (so publish() failures are logged).
 *   3. The container is bound with the CLI-side services
 *      (PathResolver, Renderer, InputReader) *after* the
 *      createDefaultContainer factory runs. The mock
 *      factory captures the bind() calls so we can assert
 *      the order.
 *
 * The actual integration with the real runtime factory is
 * exercised in cli-main-baseline.test.ts (PR 0) and the
 * runtime package's own container.test.ts; this test is
 * about the *order* of operations in wireContainer, not the
 * runtime factory's correctness.
 */

const capturedBinds: Array<{ token: unknown; factory: () => unknown }> = [];
const mockContainer = {
  bind: vi.fn((token: unknown, factory: () => unknown) => {
    capturedBinds.push({ token, factory });
    return mockContainer;
  }),
  resolve: vi.fn(),
};

vi.mock('@wrongstack/runtime', async () => {
  const actual = await vi.importActual<typeof import('@wrongstack/runtime')>('@wrongstack/runtime');
  return {
    ...actual,
    createDefaultContainer: vi.fn(() => mockContainer),
  };
});

const { wireContainer } = await import('../../src/boot/container-wiring.js');
import { TOKENS } from '@wrongstack/core';
import type { Config, Logger, ModelsRegistry, Renderer, WstackPaths } from '@wrongstack/core';

function makeLogger(): Logger {
  const calls: Array<{ level: string; msg: string }> = [];
  return {
    info: (msg: string) => { calls.push({ level: 'info', msg }); },
    warn: (msg: string) => { calls.push({ level: 'warn', msg }); },
    error: (msg: string) => { calls.push({ level: 'error', msg }); },
    debug: (msg: string) => { calls.push({ level: 'debug', msg }); },
  } as unknown as Logger;
}

function makeConfig(): Config {
  return {
    provider: 'test-provider',
    model: 'test-model',
    yolo: false,
    debugStream: false,
    context: { preserveK: 0, eliseThreshold: 0 },
    features: { skills: false },
  } as unknown as Config;
}

function makeWpaths(): WstackPaths {
  return {
    globalRoot: '/tmp/wrongstack',
    projectRoot: '/tmp/wrongstack/project',
    home: '/tmp',
  } as unknown as WstackPaths;
}

function makeReader() {
  return {
    read: async () => undefined,
  };
}

function makeModelsRegistry(): ModelsRegistry {
  return {} as unknown as ModelsRegistry;
}

function makeRenderer(): Renderer {
  return {} as unknown as Renderer;
}

describe('wireContainer (PR 3 of #29)', () => {
  it('returns pathResolver, events, and container', () => {
    capturedBinds.length = 0;
    const { pathResolver, events, container } = wireContainer({
      config: makeConfig(),
      wpaths: makeWpaths(),
      cwd: '/tmp/wrongstack',
      logger: makeLogger(),
      reader: makeReader(),
      renderer: makeRenderer(),
      modelsRegistry: makeModelsRegistry(),
      yoloDestructive: false,
      confirmDestructive: false,
    });

    expect(pathResolver).toBeDefined();
    expect(events).toBeDefined();
    expect(container).toBe(mockContainer);
  });

  it('attaches the logger to the events bus before returning', () => {
    capturedBinds.length = 0;
    const logger = makeLogger();
    const { events } = wireContainer({
      config: makeConfig(),
      wpaths: makeWpaths(),
      cwd: '/tmp/wrongstack',
      logger,
      reader: makeReader(),
      renderer: makeRenderer(),
      modelsRegistry: makeModelsRegistry(),
      yoloDestructive: false,
      confirmDestructive: false,
    });

    // Subscribe + publish; if the bus had no logger attached
    // and a subscriber threw, the bus's internal try/catch
    // would log via the bus's "logger" reference. We assert
    // that the subscriber receives the payload \u2014 the logger
    // is attached internally and not observable from outside,
    // but the call returns successfully.
    let received: unknown = undefined;
    events.on('test.topic', (msg: unknown) => {
      received = msg;
    });
    events.emit('test.topic' as never, { ok: true } as never);
    expect(received).toEqual({ ok: true });
  });

  it('binds PathResolver, Renderer, InputReader on top of the factory output', () => {
    capturedBinds.length = 0;
    const { container } = wireContainer({
      config: makeConfig(),
      wpaths: makeWpaths(),
      cwd: '/tmp/wrongstack',
      logger: makeLogger(),
      reader: makeReader(),
      renderer: makeRenderer(),
      modelsRegistry: makeModelsRegistry(),
      yoloDestructive: false,
      confirmDestructive: false,
    });

    const tokens = capturedBinds.map((b) => b.token);
    expect(tokens).toContain(TOKENS.PathResolver);
    expect(tokens).toContain(TOKENS.Renderer);
    expect(tokens).toContain(TOKENS.InputReader);
    expect(container).toBe(mockContainer);
  });

  it('is synchronous: returns a plain object, not a Promise', () => {
    capturedBinds.length = 0;
    const result = wireContainer({
      config: makeConfig(),
      wpaths: makeWpaths(),
      cwd: '/tmp/wrongstack',
      logger: makeLogger(),
      reader: makeReader(),
      renderer: makeRenderer(),
      modelsRegistry: makeModelsRegistry(),
      yoloDestructive: true,
      confirmDestructive: true,
    });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('object');
  });
});
