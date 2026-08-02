import type { HqGovernanceSnapshotPayload } from '@wrongstack/core/hq';
import { describe, expect, it, vi } from 'vitest';
import {
  projectGovernanceHqSnapshot,
  startGovernanceHqTelemetry,
} from '../src/governance-hq-telemetry.js';

describe('governance HQ telemetry', () => {
  it('projects only token-free advisory status and preserves model execution', () => {
    const payload = projectGovernanceHqSnapshot('project-1', '2026-08-02T12:00:00.000Z', {
      available: true,
      status: {
        schemaVersion: 1,
        projectId: 'project-1',
        pid: 321,
        instanceId: 'secret-internal-instance',
        startedAt: '2026-08-02T11:00:00.000Z',
        signal: {
          level: 'warning',
          code: 'attachment_broker_degraded',
          message: 'internal detail',
          operatorAction: 'investigate',
          executionDisposition: 'continue',
        },
        attachmentBroker: {
          state: 'retry_wait',
          health: 'degraded',
          consecutiveFailures: 3,
          pendingRevocations: 0,
          auditHealthy: true,
        },
      },
    });

    expect(payload.signal.executionDisposition).toBe('continue');
    expect(payload.signal.code).toBe('attachment_broker_degraded');
    expect(payload.daemon).toEqual({ pid: 321, startedAt: '2026-08-02T11:00:00.000Z' });
    expect(JSON.stringify(payload)).not.toContain('secret-internal-instance');
    expect(JSON.stringify(payload)).not.toContain('internal detail');
  });

  it('publishes failures as advisory snapshots and stops polling cleanly', async () => {
    vi.useFakeTimers();
    const published: HqGovernanceSnapshotPayload[] = [];
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce({
        available: false,
        code: 'broker_missing',
        message: 'not active',
      })
      .mockRejectedValueOnce(new Error('must not escape'));
    const stop = startGovernanceHqTelemetry({
      publisher: {
        project: {
          projectId: 'project-1',
          projectRoot: 'D:/project',
          projectName: 'project',
          machineId: 'machine-1',
          workspaceKind: 'git',
        },
        publishEvent: ((event: { payload: HqGovernanceSnapshotPayload }) => {
          published.push(event.payload);
          return {};
        }) as never,
      },
      projectRoot: 'D:/project',
      intervalMs: 100,
      now: () => '2026-08-02T12:00:00.000Z',
      readStatus,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(published[0]?.signal).toEqual({
      level: 'unavailable',
      code: 'broker_missing',
      operatorAction: 'observe',
      executionDisposition: 'continue',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(published[1]?.signal.code).toBe('connection_failed');

    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(readStatus).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
