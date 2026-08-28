import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  appendFile: vi.fn(),
  stat: vi.fn(),
  rename: vi.fn(),
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
  appendFile: mocks.appendFile,
  stat: mocks.stat,
  rename: mocks.rename,
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
        reason?: string;
        oldState?: 'healthy' | 'degraded' | 'blocked';
        timestamp?: number;
        stateExpiresAt?: number;
        lastErrorKind?: string;
        lastErrorStatus?: number | null;
        lastErrorMessage?: string | null;
        lastSessionId?: string | null;
        lastAgentId?: string | null;
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
    profileProviderAudit: vi.fn(() => 'C:/profile/provider-status-audit.jsonl'),
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
  mocks.stat.mockRejectedValue(missingError());
  mocks.appendFile.mockResolvedValue(undefined);
  mocks.rename.mockResolvedValue(undefined);
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
    // The audit append takes the first lock (its failure warns and continues);
    // the FIRST waiting-room persistence write is the one that must fail and
    // requeue here.
    mocks.withFileLock
      .mockRejectedValueOnce(new Error('lock failed (audit append)'))
      .mockRejectedValueOnce(new Error('lock failed'));
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

  it('does not resurrect a manually cleared pair during cross-sync and purges its stale row', async () => {
    const state = harness();
    const staleRowFile = JSON.stringify({
      statuses: [{ providerId: 'cleared', model: 'm', state: 'blocked', lastFailureAt: 1 }],
    });
    mocks.readFile
      .mockRejectedValueOnce(missingError()) // boot: no saved room
      .mockImplementation(async () => staleRowFile); // peer still holds the stale row
    await setupProviderStatus(state.input as never);
    const tracker = mocks.trackerInstances[0]!;

    state.emitStatus({
      providerId: 'cleared',
      model: 'm',
      newState: 'healthy',
      reason: 'manual_clear',
    });
    await vi.advanceTimersByTimeAsync(100); // debounced persist of the clear
    mocks.atomicWrite.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    // The stale row never reached the tracker…
    expect(tracker.restoreSnapshot).toHaveBeenCalledWith({ statuses: [] });
    // …and was purged from disk so the next boot cannot restore it either.
    expect(mocks.atomicWrite).toHaveBeenCalled();
    const persisted = JSON.parse(String(mocks.atomicWrite.mock.calls.at(-1)?.[1]));
    expect(persisted.statuses).toEqual([]);
    state.teardownHandlers[0]?.();
  });

  it('imports a pair that failed again after the local clear (newer wins)', async () => {
    const state = harness();
    const clearedAt = Date.now();
    const freshRowFile = JSON.stringify({
      statuses: [
        {
          providerId: 'flaky',
          model: 'm',
          state: 'blocked',
          lastFailureAt: clearedAt + 5_000, // failed again AFTER the local clear
        },
      ],
    });
    mocks.readFile
      .mockRejectedValueOnce(missingError())
      .mockImplementation(async () => freshRowFile);
    await setupProviderStatus(state.input as never);
    const tracker = mocks.trackerInstances[0]!;

    state.emitStatus({
      providerId: 'flaky',
      model: 'm',
      newState: 'healthy',
      reason: 'manual_clear',
    });
    await vi.advanceTimersByTimeAsync(30_000);

    // A fresh failure after the clear is honest state: it is imported…
    expect(tracker.restoreSnapshot).toHaveBeenCalledWith({
      statuses: [expect.objectContaining({ providerId: 'flaky', model: 'm' })],
    });
    // …and the tombstone is lifted, so later sweeps keep importing it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tracker.restoreSnapshot).toHaveBeenCalledTimes(2);
    state.teardownHandlers[0]?.();
  });

  it('does not tombstone organic recoveries from cross-sync', async () => {
    const state = harness();
    const rowFile = JSON.stringify({
      statuses: [{ providerId: 'busy', model: 'm', state: 'blocked', lastFailureAt: 1 }],
    });
    mocks.readFile
      .mockRejectedValueOnce(missingError())
      .mockImplementation(async () => rowFile);
    await setupProviderStatus(state.input as never);
    const tracker = mocks.trackerInstances[0]!;

    // Organic recovery (waiting-room expiry) — not a manual clear.
    state.emitStatus({
      providerId: 'busy',
      model: 'm',
      newState: 'healthy',
      reason: 'waiting_room_expired',
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(tracker.restoreSnapshot).toHaveBeenCalledWith({
      statuses: [expect.objectContaining({ providerId: 'busy' })],
    });
    state.teardownHandlers[0]?.();
  });

  it('does not let a stale peer row overwrite a fresher local failure', async () => {
    const state = harness();
    const staleRowFile = JSON.stringify({
      statuses: [{ providerId: 'live', model: 'm', state: 'blocked', lastFailureAt: 1_000 }],
    });
    mocks.readFile
      .mockRejectedValueOnce(missingError()) // boot: no saved room
      .mockImplementation(async () => staleRowFile);
    await setupProviderStatus(state.input as never);
    const tracker = mocks.trackerInstances[0]!;
    tracker.getStatus.mockImplementation(() => ({ lastFailureAt: 5_000, state: 'blocked' }));

    await vi.advanceTimersByTimeAsync(30_000);

    // The local failure (5s) is newer than the peer row (1s): no import.
    expect(tracker.restoreSnapshot).toHaveBeenCalledWith({ statuses: [] });
    expect(mocks.atomicWrite).not.toHaveBeenCalled();
    state.teardownHandlers[0]?.();
  });

  it('imports a peer row that is fresher than the local failure', async () => {
    const state = harness();
    const freshRowFile = JSON.stringify({
      statuses: [{ providerId: 'live', model: 'm', state: 'blocked', lastFailureAt: 5_000 }],
    });
    mocks.readFile
      .mockRejectedValueOnce(missingError()) // boot: no saved room
      .mockImplementation(async () => freshRowFile);
    await setupProviderStatus(state.input as never);
    const tracker = mocks.trackerInstances[0]!;
    tracker.getStatus.mockReturnValue({ lastFailureAt: 1_000, state: 'degraded' });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(tracker.restoreSnapshot).toHaveBeenCalledWith({
      statuses: [expect.objectContaining({ providerId: 'live', model: 'm' })],
    });
    state.teardownHandlers[0]?.();
  });

  it('refreshes instead of purging a stale row for a locally re-blocked pair', async () => {
    const state = harness();
    const staleRowFile = JSON.stringify({
      statuses: [{ providerId: 'again', model: 'm', state: 'blocked', lastFailureAt: 1 }],
    });
    mocks.readFile
      .mockRejectedValueOnce(missingError()) // boot: no saved room
      .mockImplementation(async () => staleRowFile);
    await setupProviderStatus(state.input as never);
    const tracker = mocks.trackerInstances[0]!;

    state.emitStatus({
      providerId: 'again',
      model: 'm',
      newState: 'healthy',
      reason: 'manual_clear',
    });
    await vi.advanceTimersByTimeAsync(100);
    mocks.atomicWrite.mockClear();
    // Locally re-blocked after the clear (local failure not newer than the row).
    tracker.getStatus.mockImplementation(() => ({
      providerId: 'again',
      model: 'm',
      lastFailureAt: 1,
      state: 'blocked',
    }));

    await vi.advanceTimersByTimeAsync(30_000);

    // The stale row is refreshed from the live tracker instead of purged…
    expect(tracker.restoreSnapshot).toHaveBeenCalledWith({ statuses: [] });
    expect(mocks.atomicWrite).toHaveBeenCalled();
    const persisted = JSON.parse(String(mocks.atomicWrite.mock.calls.at(-1)?.[1]));
    expect(persisted.statuses).toEqual([
      expect.objectContaining({ providerId: 'again', model: 'm', state: 'blocked' }),
    ]);
    state.teardownHandlers[0]?.();
  });

  it('appends a durable audit line with error and session context per transition', async () => {
    const state = harness();
    mocks.readFile.mockRejectedValueOnce(missingError());
    await setupProviderStatus(state.input as never);

    state.emitStatus({
      providerId: 'openai',
      model: 'gpt-4o',
      newState: 'blocked',
      oldState: 'healthy',
      reason: 'rate_limit_threshold_1',
      timestamp: 1234,
      stateExpiresAt: 9999,
      lastErrorKind: 'rate_limit',
      lastErrorStatus: 429,
      lastErrorMessage: 'Too many requests',
      lastSessionId: 'sess_1',
      lastAgentId: 'agent_1',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.appendFile).toHaveBeenCalledTimes(1);
    expect(mocks.appendFile.mock.calls[0]?.[0]).toBe('C:/profile/provider-status-audit.jsonl');
    const line = JSON.parse(String(mocks.appendFile.mock.calls[0]?.[1]));
    expect(line).toEqual({
      ts: 1234,
      providerId: 'openai',
      model: 'gpt-4o',
      from: 'healthy',
      to: 'blocked',
      reason: 'rate_limit_threshold_1',
      expiresAt: 9999,
      error: {
        kind: 'rate_limit',
        status: 429,
        message: 'Too many requests',
        sessionId: 'sess_1',
        agentId: 'agent_1',
      },
    });
    state.teardownHandlers[0]?.();
  });

  it('omits the error object on transitions without a failure', async () => {
    const state = harness();
    mocks.readFile.mockRejectedValueOnce(missingError());
    await setupProviderStatus(state.input as never);

    state.emitStatus({
      providerId: 'openai',
      model: 'gpt-4o',
      newState: 'healthy',
      oldState: 'blocked',
      reason: 'cooldown_expired',
      timestamp: 5,
    });
    await vi.advanceTimersByTimeAsync(0);

    const line = JSON.parse(String(mocks.appendFile.mock.calls.at(-1)?.[1]));
    expect(line).toMatchObject({ providerId: 'openai', to: 'healthy', reason: 'cooldown_expired' });
    expect(line.error).toBeNull();
    state.teardownHandlers[0]?.();
  });

  it('rotates the audit file when it grows past the size cap', async () => {
    const state = harness();
    mocks.readFile.mockRejectedValueOnce(missingError());
    mocks.stat.mockResolvedValue({ size: 6 * 1024 * 1024 });
    await setupProviderStatus(state.input as never);

    state.emitStatus({
      providerId: 'openai',
      model: 'gpt-4o',
      newState: 'blocked',
      oldState: 'healthy',
      reason: 'rate_limit_threshold_1',
      timestamp: 1,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.rename).toHaveBeenCalledWith(
      'C:/profile/provider-status-audit.jsonl',
      'C:/profile/provider-status-audit.jsonl.1',
    );
    expect(mocks.appendFile).toHaveBeenCalled();
    state.teardownHandlers[0]?.();
  });

  it('keeps the runtime alive when the audit append fails', async () => {
    const state = harness();
    mocks.readFile.mockRejectedValueOnce(missingError());
    mocks.appendFile.mockRejectedValueOnce(new Error('disk full'));
    await setupProviderStatus(state.input as never);

    state.emitStatus({
      providerId: 'openai',
      model: 'gpt-4o',
      newState: 'blocked',
      oldState: 'healthy',
      reason: 'rate_limit_threshold_1',
      timestamp: 1,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(state.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not append provider audit log'),
    );
    state.teardownHandlers[0]?.();
  });
});
