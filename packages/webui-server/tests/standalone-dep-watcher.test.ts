/**
 * Editing a manifest in desktop used to trigger nothing: the standalone engine never wired
 * the dependency watcher, its tech-stack consumer or the package-outdated watcher the CLI
 * starts. It now calls the same `@wrongstack/runtime/dep-watcher` functions.
 */
import { EventBus } from '@wrongstack/contracts/kernel';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const coordination = vi.hoisted(() => ({
  bridgeStop: vi.fn(),
  consumerStop: vi.fn(),
  outdatedStop: vi.fn(),
  attachDepWatcherBridge: vi.fn(),
  startTechStackConsumer: vi.fn(),
  startPackageOutdatedWatcher: vi.fn(),
}));
vi.mock('@wrongstack/coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/coordination')>()),
  getSharedProjectMailbox: vi.fn(() => ({ send: vi.fn() })),
  attachDepWatcherBridge: coordination.attachDepWatcherBridge,
  startTechStackConsumer: coordination.startTechStackConsumer,
  startPackageOutdatedWatcher: coordination.startPackageOutdatedWatcher,
}));

import { startStandaloneDepWatcher } from '../src/server/standalone-dep-watcher.js';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  coordination.attachDepWatcherBridge.mockReturnValue(coordination.bridgeStop);
  coordination.startTechStackConsumer.mockReturnValue(coordination.consumerStop);
  coordination.startPackageOutdatedWatcher.mockReturnValue(coordination.outdatedStop);
});

function start(
  options: { extensions?: Record<string, Record<string, unknown>>; host?: boolean } = {},
): {
  dispose: () => void;
  spawn: ReturnType<typeof vi.fn>;
} {
  const spawn = vi.fn(async () => ({ subagentId: 'sa-1', taskId: 't-1' }));
  const dispose = startStandaloneDepWatcher({
    config: options.extensions ? { extensions: options.extensions } : {},
    paths: { globalRoot: '/tmp/global', projectSlug: 'proj' },
    projectRoot: '/tmp/proj',
    events: new EventBus(),
    logger,
    host: options.host === false ? undefined : { spawn, getDirector: () => undefined },
    sessionId: 'boot',
  });
  return { dispose, spawn };
}

describe('standalone dependency watcher', () => {
  it('is on by default: bridge, tech-stack consumer and package-outdated watcher', async () => {
    const { dispose, spawn } = start();
    expect(coordination.attachDepWatcherBridge).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/tmp/proj', targetAgent: 'tech-stack' }),
    );
    expect(coordination.startTechStackConsumer).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'boot', targetAgent: 'tech-stack' }),
    );
    expect(coordination.startPackageOutdatedWatcher).toHaveBeenCalledOnce();

    // A dependency change becomes an audit spawned through the engine's fleet host.
    const { onSpawn } = coordination.startTechStackConsumer.mock.calls[0]![0] as {
      onSpawn: (task: string, name: string) => Promise<unknown>;
    };
    await expect(onSpawn('audit zod', 'tech-stack-audit')).resolves.toEqual({
      subagentId: 'sa-1',
      taskId: 't-1',
    });
    expect(spawn).toHaveBeenCalledWith('audit zod', {
      name: 'tech-stack-audit',
      tools: ['read', 'fetch', 'mailbox'],
      gracefulFinish: true,
    });

    dispose();
    expect(coordination.bridgeStop).toHaveBeenCalledOnce();
    expect(coordination.consumerStop).toHaveBeenCalledOnce();
    expect(coordination.outdatedStop).toHaveBeenCalledOnce();
  });

  it('honours the same opt-out as the CLI', () => {
    start({ extensions: { 'file-watcher': { depWatcher: { enabled: false } } } });
    expect(coordination.attachDepWatcherBridge).not.toHaveBeenCalled();
    expect(coordination.startTechStackConsumer).not.toHaveBeenCalled();
    expect(coordination.startPackageOutdatedWatcher).not.toHaveBeenCalled();
  });

  it('runs only the bridge without a fleet host to spawn audits through', () => {
    const { dispose } = start({ host: false });
    expect(coordination.attachDepWatcherBridge).toHaveBeenCalledOnce();
    expect(coordination.startTechStackConsumer).not.toHaveBeenCalled();
    dispose();
    expect(coordination.bridgeStop).toHaveBeenCalledOnce();
  });
});
