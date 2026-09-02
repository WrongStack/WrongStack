import { describe, expect, it, vi } from 'vitest';
import type { HqWorktreeEventPayload } from '../../src/hq/protocol.js';
import type { HqPublisher } from '../../src/hq/publisher.js';
import { startWorktreeTelemetryBridge } from '../../src/hq/worktree-bridge.js';
import { EventBus } from '../../src/kernel/events.js';

function fakePublisher(spy: ReturnType<typeof vi.fn>): HqPublisher {
  return {
    publishEvent: (o: { type: string; payload: unknown }) => {
      spy(o);
      return {} as never;
    },
  } as unknown as HqPublisher;
}

describe('startWorktreeTelemetryBridge', () => {
  it('forwards worktree.allocated', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    const stop = startWorktreeTelemetryBridge({ events, publisher, sessionId: 's1' });
    events.emit('worktree.allocated', {
      handleId: 'h1',
      ownerId: 'phase-1',
      ownerLabel: 'Phase 1',
      slug: 'phase-1',
      dir: '/tmp/wt',
      branch: 'phase-1',
      baseBranch: 'main',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0];
    expect(call.type).toBe('worktree.event');
    const payload: HqWorktreeEventPayload = call.payload;
    expect(payload.kind).toBe('allocated');
    expect(payload.handleId).toBe('h1');
    expect(payload.ownerId).toBe('phase-1');
    expect(payload.branch).toBe('phase-1');
    stop();
  });

  it('forwards worktree.committed with diff stats', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startWorktreeTelemetryBridge({ events, publisher });
    events.emit('worktree.committed', {
      handleId: 'h1',
      ownerId: 'phase-1',
      branch: 'phase-1',
      committed: true,
      insertions: 42,
      deletions: 7,
      files: 3,
      sha: 'abc123',
    });
    const payload: HqWorktreeEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.kind).toBe('committed');
    expect(payload.insertions).toBe(42);
    expect(payload.deletions).toBe(7);
    expect(payload.files).toBe(3);
    expect(payload.sha).toBe('abc123');
  });

  it('forwards worktree.conflict with conflict files', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startWorktreeTelemetryBridge({ events, publisher });
    events.emit('worktree.conflict', {
      handleId: 'h1',
      ownerId: 'phase-1',
      branch: 'phase-1',
      conflictFiles: ['a.ts', 'b.ts'],
    });
    const payload: HqWorktreeEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.kind).toBe('conflict');
    expect(payload.conflictFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('forwards worktree.failed with error', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startWorktreeTelemetryBridge({ events, publisher });
    events.emit('worktree.failed', {
      handleId: 'h1',
      ownerId: 'phase-1',
      branch: 'phase-1',
      error: 'merge conflict',
    });
    const payload: HqWorktreeEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.kind).toBe('failed');
    expect(payload.error).toBe('merge conflict');
  });

  it('forwards worktree.merged and worktree.released', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startWorktreeTelemetryBridge({ events, publisher });
    events.emit('worktree.merged', {
      handleId: 'h1',
      ownerId: 'p1',
      branch: 'b',
      baseBranch: 'main',
      squash: true,
    });
    events.emit('worktree.released', { handleId: 'h1', ownerId: 'p1', branch: 'b', kept: false });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0].payload.kind).toBe('merged');
    expect(spy.mock.calls[0]![0].payload.squash).toBe(true);
    expect(spy.mock.calls[1]![0].payload.kind).toBe('released');
    expect(spy.mock.calls[1]![0].payload.kept).toBe(false);
  });

  it('disposer unsubscribes all listeners', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    const stop = startWorktreeTelemetryBridge({ events, publisher });
    stop();
    events.emit('worktree.allocated', {
      handleId: 'h1',
      ownerId: 'p1',
      ownerLabel: 'P1',
      slug: 'p1',
      dir: '/x',
      branch: 'b',
      baseBranch: 'main',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('never throws on publisher failure', () => {
    const events = new EventBus();
    const publisher = {
      publishEvent: () => {
        throw new Error('boom');
      },
    } as unknown as HqPublisher;
    const stop = startWorktreeTelemetryBridge({ events, publisher });
    expect(() =>
      events.emit('worktree.allocated', {
        handleId: 'h1',
        ownerId: 'p1',
        ownerLabel: 'P1',
        slug: 'p1',
        dir: '/x',
        branch: 'b',
        baseBranch: 'main',
      }),
    ).not.toThrow();
    stop();
  });
});
