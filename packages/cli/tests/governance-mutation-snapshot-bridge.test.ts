import { createDefaultPipelines, type ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { EventBus } from '@wrongstack/core/kernel';
import type { WorkspaceCheckpointRef } from '@wrongstack/core/types';
import { createGovernanceMutationSnapshotBridge } from '@wrongstack/runtime/governance-mutation-snapshot-bridge';
import { describe, expect, it, vi } from 'vitest';

function checkpoint(manifestHash: string): WorkspaceCheckpointRef {
  return {
    manifestHash,
    baseHead: 'b'.repeat(40),
    entryCount: 1,
    unresolvedCount: 0,
    capturedAt: '2026-08-02T12:00:00.000Z',
    coverage: 'git-head-plus-dirty',
  };
}

function recorded(manifestHash: string, revision: number) {
  return {
    recorded: true as const,
    snapshot: {
      schemaVersion: 1 as const,
      snapshotId: 'c'.repeat(64),
      projectId: 'project-1',
      revision,
      manifestHash,
      capturedAt: '2026-08-02T12:00:00.000Z',
    },
  };
}

function mutatingToolPayload() {
  return {
    toolUse: { type: 'tool_use' as const, id: 'tool-1', name: 'edit', input: {} },
    result: {
      type: 'tool_result' as const,
      tool_use_id: 'tool-1',
      content: 'edited',
    },
    ctx: { session: { id: 'session-1' } } as never,
    tool: { name: 'edit', mutating: true } as never,
  };
}

describe('CLI governance mutation snapshot bridge', () => {
  it('ignores reads, failed mutations, and legacy events without mutation metadata', async () => {
    const events = new EventBus();
    const captureWorkspaceCheckpoint = vi.fn(async () => checkpoint('a'.repeat(64)));
    const recordWorkspaceSnapshot = vi.fn(async () => recorded('a'.repeat(64), 1));
    const bridge = createGovernanceMutationSnapshotBridge({
      events,
      sink: { recordWorkspaceSnapshot },
      captureWorkspaceCheckpoint,
      logger: { warn: vi.fn() },
    });

    events.emit('tool.executed', {
      name: 'read',
      durationMs: 1,
      ok: true,
      mutating: false,
    });
    events.emit('tool.executed', {
      name: 'edit',
      durationMs: 1,
      ok: false,
      mutating: true,
    });
    events.emit('tool.executed', { name: 'legacy-edit', durationMs: 1, ok: true });
    await bridge.close();

    expect(captureWorkspaceCheckpoint).not.toHaveBeenCalled();
    expect(recordWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('serializes fresh identities after successful mutations and flushes them on close', async () => {
    const events = new EventBus();
    const hashes = ['a'.repeat(64), 'b'.repeat(64)];
    const captureWorkspaceCheckpoint = vi
      .fn<() => Promise<WorkspaceCheckpointRef | undefined>>()
      .mockResolvedValueOnce(checkpoint(hashes[0] ?? ''))
      .mockResolvedValueOnce(checkpoint(hashes[1] ?? ''));
    const recordWorkspaceSnapshot = vi
      .fn<(hash: string) => Promise<ReturnType<typeof recorded>>>()
      .mockImplementation(async (hash) =>
        recorded(hash, recordWorkspaceSnapshot.mock.calls.length),
      );
    const bridge = createGovernanceMutationSnapshotBridge({
      events,
      sink: { recordWorkspaceSnapshot },
      captureWorkspaceCheckpoint,
      logger: { warn: vi.fn() },
    });

    for (const name of ['edit', 'write']) {
      events.emit('tool.executed', { name, durationMs: 1, ok: true, mutating: true });
    }
    await bridge.close();

    expect(captureWorkspaceCheckpoint).toHaveBeenCalledTimes(2);
    expect(recordWorkspaceSnapshot.mock.calls.map(([hash]) => hash)).toEqual(hashes);
  });

  it('awaits the root tool boundary and deduplicates its later event observation', async () => {
    const events = new EventBus();
    const order: string[] = [];
    let releaseCapture: (() => void) | undefined;
    const captureWorkspaceCheckpoint = vi.fn(
      () =>
        new Promise<WorkspaceCheckpointRef | undefined>((resolve) => {
          releaseCapture = () => {
            order.push('capture');
            resolve(checkpoint('a'.repeat(64)));
          };
        }),
    );
    const recordWorkspaceSnapshot = vi.fn(async () => recorded('a'.repeat(64), 1));
    const bridge = createGovernanceMutationSnapshotBridge({
      events,
      sink: { recordWorkspaceSnapshot },
      captureWorkspaceCheckpoint,
      logger: { warn: vi.fn() },
    });
    const pipelines = createDefaultPipelines();
    bridge.installToolBoundary(pipelines);
    pipelines.toolCall.use({
      name: 'test-downstream',
      handler: async (
        payload: ToolCallPipelinePayload,
        next: (value: ToolCallPipelinePayload) => Promise<ToolCallPipelinePayload>,
      ) => {
        order.push('downstream');
        return next(payload);
      },
    });

    let settled = false;
    const running = pipelines.toolCall.run(mutatingToolPayload()).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(captureWorkspaceCheckpoint).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(order).toEqual(['downstream']);
    releaseCapture?.();
    await running;
    events.emit('tool.executed', {
      sessionId: 'session-1',
      id: 'tool-1',
      name: 'edit',
      durationMs: 1,
      ok: true,
      mutating: true,
    });
    await bridge.close();

    expect(order).toEqual(['downstream', 'capture']);
    expect(captureWorkspaceCheckpoint).toHaveBeenCalledTimes(1);
    expect(recordWorkspaceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps the awaited compatibility boundary fail-open when capture is unavailable', async () => {
    const events = new EventBus();
    const warn = vi.fn();
    const bridge = createGovernanceMutationSnapshotBridge({
      events,
      sink: { recordWorkspaceSnapshot: vi.fn() },
      captureWorkspaceCheckpoint: async () => undefined,
      logger: { warn },
    });
    const pipelines = createDefaultPipelines();
    bridge.installToolBoundary(pipelines);

    await expect(pipelines.toolCall.run(mutatingToolPayload())).resolves.toMatchObject({
      result: { content: 'edited' },
    });
    await bridge.close();
    expect(warn).toHaveBeenCalledWith(
      'governance: failed to capture a valid post-mutation workspace identity',
    );
  });

  it('waits for saturated fallback work instead of dropping the awaited root boundary', async () => {
    const events = new EventBus();
    let releaseFirstCapture: (() => void) | undefined;
    let captureCount = 0;
    const captureWorkspaceCheckpoint = vi.fn(async () => {
      captureCount += 1;
      if (captureCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstCapture = resolve;
        });
      }
      return checkpoint('a'.repeat(64));
    });
    const recordWorkspaceSnapshot = vi.fn(async () => recorded('a'.repeat(64), 1));
    const bridge = createGovernanceMutationSnapshotBridge({
      events,
      sink: { recordWorkspaceSnapshot },
      captureWorkspaceCheckpoint,
      logger: { warn: vi.fn() },
    });
    const pipelines = createDefaultPipelines();
    bridge.installToolBoundary(pipelines);
    for (let index = 0; index < 64; index += 1) {
      events.emit('tool.executed', {
        name: 'edit',
        durationMs: 1,
        ok: true,
        mutating: true,
      });
    }
    await vi.waitFor(() => expect(captureWorkspaceCheckpoint).toHaveBeenCalledTimes(1));

    let settled = false;
    const running = pipelines.toolCall.run(mutatingToolPayload()).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFirstCapture?.();
    await running;
    await bridge.close();

    expect(captureWorkspaceCheckpoint).toHaveBeenCalledTimes(65);
    expect(recordWorkspaceSnapshot).toHaveBeenCalledTimes(65);
  });

  it('contains capture failures without changing the completed tool result', async () => {
    const events = new EventBus();
    const warn = vi.fn();
    const recordWorkspaceSnapshot = vi.fn();
    const bridge = createGovernanceMutationSnapshotBridge({
      events,
      sink: { recordWorkspaceSnapshot },
      captureWorkspaceCheckpoint: async () => undefined,
      logger: { warn },
    });

    events.emit('tool.executed', { name: 'edit', durationMs: 1, ok: true, mutating: true });
    await bridge.close();

    expect(recordWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'governance: failed to capture a valid post-mutation workspace identity',
    );
  });

  it('bounds queued mutation snapshots while preserving already accepted work', async () => {
    const events = new EventBus();
    const warn = vi.fn();
    const captureWorkspaceCheckpoint = vi.fn(async () => checkpoint('a'.repeat(64)));
    const recordWorkspaceSnapshot = vi.fn(async () => recorded('a'.repeat(64), 1));
    const bridge = createGovernanceMutationSnapshotBridge({
      events,
      sink: { recordWorkspaceSnapshot },
      captureWorkspaceCheckpoint,
      logger: { warn },
    });

    for (let index = 0; index < 65; index += 1) {
      events.emit('tool.executed', {
        name: 'edit',
        durationMs: 1,
        ok: true,
        mutating: true,
      });
    }
    await bridge.close();

    expect(captureWorkspaceCheckpoint).toHaveBeenCalledTimes(64);
    expect(recordWorkspaceSnapshot).toHaveBeenCalledTimes(64);
    expect(warn).toHaveBeenCalledWith(
      'governance: mutation snapshot queue reached bounded capacity',
      { capacity: 64 },
    );
  });
});
