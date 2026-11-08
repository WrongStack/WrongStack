import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { LegacySessionRegistry as SessionRegistry } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridges = vi.hoisted(() => ({
  stops: [] as Array<ReturnType<typeof vi.fn>>,
  calls: [] as Array<{ bridge: string; sessionId: unknown; publisher: unknown }>,
}));
vi.mock('@wrongstack/hq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/hq')>();
  const spy =
    (bridge: string) =>
    (options: { sessionId?: unknown; publisher?: unknown }): (() => void) => {
      bridges.calls.push({ bridge, sessionId: options.sessionId, publisher: options.publisher });
      const stop = vi.fn();
      bridges.stops.push(stop);
      return stop;
    };
  return {
    ...actual,
    startFleetTelemetryBridge: spy('fleet'),
    startBrainTelemetryBridge: spy('brain'),
    startWorktreeTelemetryBridge: spy('worktree'),
    startToolTelemetryBridge: spy('tool'),
    startCostTelemetryBridge: spy('cost'),
    createHqPublisherFromEnv: vi.fn(() => {
      throw new Error('the identity lifecycle must not open an HQ connection of its own');
    }),
  };
});

import { createStandaloneSessionIdentityLifecycle } from '../src/server/standalone-session-identity.js';

const logger = {
  level: 'error',
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
  child() {
    return logger;
  },
} as Logger;

describe('standalone session identity HQ bridges', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-identity-hq-'));
    bridges.stops.length = 0;
    bridges.calls.length = 0;
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('binds the engine-wide bridges to the presence’s publisher and follows the active session', async () => {
    const globalRoot = path.join(root, 'global');
    const lifecycle = await createStandaloneSessionIdentityLifecycle({
      config: {} as never,
      events: new EventBus(),
      logger,
      paths: { globalRoot, projectRoot: root, projectSlug: 'p' },
      workingDir: root,
      initialSessionId: 'boot',
      sessionRegistry: new SessionRegistry(globalRoot),
    });
    // Nothing is published until the engine's one HQ connection hands its publisher over.
    expect(bridges.calls).toEqual([]);

    const publisher = { name: 'publisher' };
    lifecycle.bindHqPublisher(publisher as never);
    expect(bridges.calls.map((call) => call.bridge)).toEqual([
      'fleet',
      'brain',
      'worktree',
      'tool',
      'cost',
    ]);
    expect(bridges.calls.every((call) => call.sessionId === 'boot')).toBe(true);
    expect(bridges.calls.every((call) => call.publisher === publisher)).toBe(true);

    await lifecycle.activate('next');
    expect(bridges.stops.slice(0, 5).every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(bridges.calls.slice(5).every((call) => call.sessionId === 'next')).toBe(true);

    lifecycle.bindHqPublisher(undefined);
    expect(bridges.stops.slice(5).every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(bridges.calls).toHaveLength(10);
    await lifecycle.stop();
  });
});
