import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  atomicWrite: vi.fn(),
  withFileLock: vi.fn(),
  trackerInstances: [] as Array<{
    restoreSnapshot: ReturnType<typeof vi.fn>;
    sweepExpired: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
}));

vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return {
    ...actual,
    atomicWrite: mocks.atomicWrite,
    withFileLock: mocks.withFileLock,
  };
});

vi.mock('@wrongstack/core/coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/coordination')>();
  return {
    ...actual,
    ProviderModelStatusTracker: class {
      restoreSnapshot = vi.fn();
      sweepExpired = vi.fn();
      getStatus = vi.fn();

      constructor() {
        mocks.trackerInstances.push(this);
      }
    },
  };
});

import { setupProviderStatus } from '../src/wiring/provider-status.js';

function missingError() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function harness() {
  let statusHandler:
    | ((event: {
        providerId: string;
        model: string;
        newState: 'healthy' | 'degraded' | 'blocked';
      }) => void)
    | undefined;
  const unsubscribe = vi.fn();
  const events = {
    on: vi.fn((_event: string, handler: typeof statusHandler) => {
      statusHandler = handler;
      return unsubscribe;
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const fallbackProfileManager = { setStatusTracker: vi.fn() };
  const teardownHandlers: Array<() => void> = [];
  const paths = {
    profileName: 'default',
    profileProviderStatus: vi.fn(() => 'C:/profile/provider-status.json'),
  };
  return {
    input: {
      events,
      paths,
      fallbackProfileManager,
      logger,
      teardownHandlers,
    },
    emitStatus(event: Parameters<NonNullable<typeof statusHandler>>[0]) {
      statusHandler?.(event);
    },
    events,
    unsubscribe,
    logger,
    fallbackProfileManager,
    teardownHandlers,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.trackerInstances.length = 0;
  mocks.withFileLock.mockImplementation(async (_file, callback) => callback());
  mocks.atomicWrite.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setupProviderStatus', () => {
  it('restores saved status and persists a coalesced degraded change', async () => {
    const state = harness();
    mocks.readFile
      .mockResolvedValueOnce('{"statuses":[{"providerId":"saved","model":"m"}]}')
      .mockResolvedValueOnce(
        JSON.stringify({
          statuses: [
            null,
            { providerId: 'provider', model: 'model', state: 'blocked' },
            { providerId: 'other', model: 'model', state: 'degraded' },
          ],
        }),
      );

    const setup = setupProviderStatus(state.input as never);
    const tracker = mocks.trackerInstances[0]!;
    tracker.restoreSnapshot.mockReturnValue(1);
    const resolved = await setup;
    expect(resolved).toBe(tracker);
    expect(state.logger.info).toHaveBeenCalledWith('Restored 1 provider waiting-room entries');
    expect(state.fallbackProfileManager.setStatusTracker).toHaveBeenCalledWith(tracker);

    tracker.getStatus.mockReturnValue({
      providerId: 'provider',
      model: 'model',
      state: 'degraded',
    });
    state.emitStatus({
      providerId: 'provider',
      model: 'model',
      newState: 'degraded',
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.atomicWrite).toHaveBeenCalledWith(
      'C:/profile/provider-status.json',
      expect.stringContaining('"providerId": "provider"'),
      { mode: 0o600 },
    );
    const persisted = JSON.parse(String(mocks.atomicWrite.mock.calls[0]?.[1]));
    expect(persisted.statuses).toEqual([
      { providerId: 'other', model: 'model', state: 'degraded' },
      { providerId: 'provider', model: 'model', state: 'degraded' },
    ]);

    state.teardownHandlers[0]?.();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });

  it('omits healthy and unavailable tracker states from persistence', async () => {
    const state = harness();
    mocks.readFile.mockRejectedValueOnce(missingError()).mockResolvedValueOnce('{"statuses":[]}');
    await setupProviderStatus(state.input as never);
    const tracker = mocks.trackerInstances[0]!;
    tracker.getStatus.mockReturnValue(undefined);

    state.emitStatus({
      providerId: 'provider',
      model: 'healthy',
      newState: 'healthy',
    });
    state.emitStatus({
      providerId: 'provider',
      model: 'missing',
      newState: 'blocked',
    });
    await vi.advanceTimersByTimeAsync(100);

    const persisted = JSON.parse(String(mocks.atomicWrite.mock.calls[0]?.[1]));
    expect(persisted.statuses).toEqual([]);
    expect(state.logger.warn).not.toHaveBeenCalled();
    state.teardownHandlers[0]?.();
  });

  it('sweeps and synchronizes external status changes every thirty seconds', async () => {
    const state = harness();
    mocks.readFile
      .mockRejectedValueOnce(missingError())
      .mockResolvedValueOnce('{"statuses":[{"providerId":"external"}]}');
    await setupProviderStatus(state.input as never);
    const tracker = mocks.trackerInstances[0]!;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(tracker.sweepExpired).toHaveBeenCalledOnce();
    expect(tracker.restoreSnapshot).toHaveBeenCalledWith({
      statuses: [{ providerId: 'external' }],
    });
    state.teardownHandlers[0]?.();
  });

  it('reports restore and sync errors while ignoring missing files', async () => {
    const state = harness();
    mocks.readFile
      .mockRejectedValueOnce(new Error('restore broken'))
      .mockRejectedValueOnce('sync broken');
    await setupProviderStatus(state.input as never);

    expect(state.logger.warn).toHaveBeenCalledWith(
      'Could not restore provider waiting room: restore broken',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.logger.warn).toHaveBeenCalledWith(
      'Could not sync provider waiting room: sync broken',
    );
    state.teardownHandlers[0]?.();
  });

  it('requeues failed saves and reports timer persistence errors', async () => {
    const state = harness();
    mocks.readFile.mockRejectedValueOnce(missingError());
    mocks.withFileLock.mockRejectedValueOnce(new Error('lock failed'));
    await setupProviderStatus(state.input as never);

    state.emitStatus({
      providerId: 'provider',
      model: 'model',
      newState: 'blocked',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(state.logger.warn).toHaveBeenCalledWith(
      'Could not persist provider waiting room: lock failed',
    );

    mocks.withFileLock.mockImplementation(async (_file, callback) => callback());
    mocks.readFile.mockRejectedValueOnce(missingError());
    state.teardownHandlers[0]?.();
    await vi.runAllTimersAsync();
    expect(mocks.atomicWrite).toHaveBeenCalled();
  });
});
