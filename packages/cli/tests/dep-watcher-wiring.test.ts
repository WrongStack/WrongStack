import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSharedProjectMailbox: vi.fn(),
  startTechStackConsumer: vi.fn(),
  startPackageOutdatedWatcher: vi.fn(),
}));

vi.mock('@wrongstack/core/coordination', () => ({
  getSharedProjectMailbox: mocks.getSharedProjectMailbox,
  startTechStackConsumer: mocks.startTechStackConsumer,
  startPackageOutdatedWatcher: mocks.startPackageOutdatedWatcher,
}));

import { setupDepWatcherConsumers } from '../src/wiring/dep-watcher.js';

function harness(dwCfg?: Record<string, unknown>) {
  const teardownHandlers: Array<() => void> = [];
  const mailbox = { send: vi.fn().mockResolvedValue(undefined) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const multiAgentHost = { spawn: vi.fn().mockResolvedValue({ id: 'spawned' }) };
  const deps = {
    dwCfg,
    globalRoot: 'C:/global',
    projectSlug: 'project',
    events: { emit: vi.fn() },
    multiAgentHost,
    sessionId: 'session-1',
    logger,
    teardownHandlers,
    projectRoot: 'C:/repo',
  };
  mocks.getSharedProjectMailbox.mockReturnValue(mailbox);
  return { deps, logger, mailbox, multiAgentHost, teardownHandlers };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setupDepWatcherConsumers', () => {
  it('does nothing when dependency watching is disabled or absent', () => {
    setupDepWatcherConsumers(harness().deps as never);
    setupDepWatcherConsumers(harness({ enabled: false }).deps as never);

    expect(mocks.getSharedProjectMailbox).not.toHaveBeenCalled();
    expect(mocks.startTechStackConsumer).not.toHaveBeenCalled();
    expect(mocks.startPackageOutdatedWatcher).not.toHaveBeenCalled();
  });

  it('starts both consumers with defaults and registers their disposers', async () => {
    const techDispose = vi.fn();
    const packageDispose = vi.fn();
    mocks.startTechStackConsumer.mockReturnValue(techDispose);
    mocks.startPackageOutdatedWatcher.mockReturnValue(packageDispose);
    const harnessed = harness({ enabled: true });

    setupDepWatcherConsumers(harnessed.deps as never);

    expect(harnessed.teardownHandlers).toEqual([packageDispose, techDispose]);
    expect(mocks.getSharedProjectMailbox).toHaveBeenCalledTimes(2);
    const techOptions = mocks.startTechStackConsumer.mock.calls[0]?.[0];
    expect(techOptions).toEqual(
      expect.objectContaining({
        targetAgent: 'tech-stack',
        consumerAgentId: 'tech-stack-consumer',
        pollIntervalMs: 5_000,
        sessionId: 'session-1',
        currentAgentId: 'leader',
        fileAuthorOpts: {
          storageDir: expect.stringContaining('projects'),
          projectRoot: 'C:/repo',
        },
      }),
    );
    await expect(techOptions.onSpawn('upgrade dependencies', 'Dep Agent')).resolves.toEqual({
      id: 'spawned',
    });
    expect(harnessed.multiAgentHost.spawn).toHaveBeenCalledWith('upgrade dependencies', {
      name: 'Dep Agent',
      tools: ['read', 'fetch', 'mailbox'],
    });
    techOptions.onLog('tech log');
    techOptions.onError(new Error('tech error'));
    techOptions.onError('tech string error');
    expect(harnessed.logger.debug).toHaveBeenCalledWith('tech log');
    expect(harnessed.logger.warn).toHaveBeenCalledWith('Tech-stack consumer error: tech error');

    const packageOptions = mocks.startPackageOutdatedWatcher.mock.calls[0]?.[0];
    expect(packageOptions).toEqual(
      expect.objectContaining({
        pollIntervalMs: 60 * 60 * 1_000,
        watcherAgentId: 'pkg-outdated-watcher',
      }),
    );
    const notification = {
      from: 'watcher',
      to: 'agent',
      subject: 'Outdated',
      body: 'Upgrade',
      priority: 'normal',
    };
    await packageOptions.onNotify(notification);
    expect(harnessed.mailbox.send).toHaveBeenCalledWith({
      ...notification,
      type: 'note',
    });
    packageOptions.onLog('package log');
    packageOptions.onError('package error');
    packageOptions.onError(new Error('package object error'));
    expect(harnessed.logger.warn).toHaveBeenCalledWith('Pkg-outdated-watcher error: package error');
    expect(harnessed.logger.warn).toHaveBeenCalledWith(
      'Pkg-outdated-watcher error: package object error',
    );
  });

  it('uses configured target and polling values', () => {
    const harnessed = harness({
      enabled: true,
      targetAgent: 'custom-agent',
      pollIntervalMs: 123,
    });
    mocks.startTechStackConsumer.mockReturnValue(undefined);
    mocks.startPackageOutdatedWatcher.mockReturnValue(undefined);

    setupDepWatcherConsumers(harnessed.deps as never);

    expect(mocks.startTechStackConsumer).toHaveBeenCalledWith(
      expect.objectContaining({ targetAgent: 'custom-agent', pollIntervalMs: 123 }),
    );
    expect(mocks.startPackageOutdatedWatcher).toHaveBeenCalledWith(
      expect.objectContaining({ pollIntervalMs: 123 }),
    );
    expect(harnessed.teardownHandlers).toEqual([]);
  });

  it('contains independent startup failures for both watchers', () => {
    const harnessed = harness({ enabled: true });
    mocks.getSharedProjectMailbox
      .mockImplementationOnce(() => {
        throw new Error('tech startup');
      })
      .mockImplementationOnce(() => {
        throw new Error('package startup');
      });

    expect(() => setupDepWatcherConsumers(harnessed.deps as never)).not.toThrow();
    expect(harnessed.logger.warn).toHaveBeenCalledWith(
      'Failed to start tech-stack consumer: Error: tech startup',
    );
    expect(harnessed.logger.warn).toHaveBeenCalledWith(
      'Failed to start package outdated watcher: Error: package startup',
    );
  });
});
