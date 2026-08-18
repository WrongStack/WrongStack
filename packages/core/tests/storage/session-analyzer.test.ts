import { describe, expect, it } from 'vitest';
import { SessionAnalyzer } from '../../src/storage/session-analyzer.js';

describe('SessionAnalyzer', () => {
  const analyzer = new SessionAnalyzer();

  it('analyzes empty events', () => {
    const result = analyzer.analyze([]);
    expect(result.errorCount).toBe(0);
    expect(result.toolUsageCount).toEqual({});
    expect(result.modeChanges).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.totalDuration).toBe(0);
  });

  it('counts tool_use events', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', id: '1', name: 'bash', input: {} },
      { type: 'tool_use', ts: '2024-01-01T00:00:01Z', id: '2', name: 'bash', input: {} },
      { type: 'tool_use', ts: '2024-01-01T00:00:02Z', id: '3', name: 'read', input: {} },
    ] as any[];
    const result = analyzer.analyze(events);
    expect(result.toolUsageCount['bash']).toBe(2);
    expect(result.toolUsageCount['read']).toBe(1);
  });

  it('counts error events', () => {
    const events = [
      { type: 'error', ts: '2024-01-01T00:00:00Z', phase: 'planning', message: 'boom' },
    ] as any[];
    const result = analyzer.analyze(events);
    expect(result.errorCount).toBe(1);
  });

  it('calculates totalDuration from events', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', id: '1', name: 'a', input: {} },
      { type: 'tool_use', ts: '2024-01-01T00:00:02Z', id: '2', name: 'b', input: {} },
    ] as any[];
    const result = analyzer.analyze(events);
    expect(result.totalDuration).toBe(2000);
  });

  it('returns 0 duration for single event', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', id: '1', name: 'a', input: {} },
    ] as any[];
    const result = analyzer.analyze(events);
    expect(result.totalDuration).toBe(0);
  });

  it('query filters by eventTypes', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', name: 'a', input: {} } as any,
      { type: 'error', ts: '2024-01-01T00:00:01Z', message: '' } as any,
      { type: 'user_input', ts: '2024-01-01T00:00:02Z', content: 'hello' } as any,
    ];
    const result = analyzer.query(events, { eventTypes: ['tool_use', 'error'] });
    expect(result).toHaveLength(2);
  });

  it('query filters by toolNames', () => {
    const events = [
      { type: 'tool_use', ts: '2024-01-01T00:00:00Z', id: '1', name: 'bash', input: {} } as any,
      { type: 'tool_use', ts: '2024-01-01T00:00:01Z', id: '2', name: 'read', input: {} } as any,
    ];
    const result = analyzer.query(events, { toolNames: ['bash'] });
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('bash');
  });

  it('query filters by timeRange', () => {
    const events = [
      { type: 'user_input', ts: '2024-01-01T00:00:00Z', content: 'a' } as any,
      { type: 'user_input', ts: '2024-01-01T00:00:05Z', content: 'b' } as any,
      { type: 'user_input', ts: '2024-01-01T00:00:10Z', content: 'c' } as any,
    ];
    const result = analyzer.query(events, {
      timeRange: { start: '2024-01-01T00:00:03Z', end: '2024-01-01T00:00:07Z' },
    });
    expect(result).toHaveLength(1);
  });

  it('query returns all when no filter', () => {
    const events = [{ type: 'user_input', ts: '2024-01-01T00:00:00Z', content: 'a' } as any];
    const result = analyzer.query(events, {});
    expect(result).toHaveLength(1);
  });

  it('captures the sessionId from session_start', () => {
    const events = [
      { type: 'session_start', ts: '2024-01-01T00:00:00Z', id: 'sess-1' } as any,
      { type: 'tool_use', ts: '2024-01-01T00:00:01Z', id: '1', name: 'a', input: {} } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.sessionId).toBe('sess-1');
  });

  it('captures the sessionId from session_resumed when no session_start present', () => {
    const events = [
      { type: 'session_resumed', ts: '2024-01-01T00:00:00Z', id: 'sess-resume' } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.sessionId).toBe('sess-resume');
  });

  it('keeps the first session id when multiple session_start events occur', () => {
    const events = [
      { type: 'session_start', ts: '2024-01-01T00:00:00Z', id: 'first' } as any,
      { type: 'session_start', ts: '2024-01-01T00:00:01Z', id: 'second' } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.sessionId).toBe('first');
  });

  it('tracks mode_changed events', () => {
    const events = [
      { type: 'mode_changed', ts: '2024-01-01T00:00:00Z', from: 'default', to: 'pair' } as any,
      { type: 'mode_changed', ts: '2024-01-01T00:00:05Z', from: 'pair', to: 'default' } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.modeChanges).toEqual([
      { ts: '2024-01-01T00:00:00Z', from: 'default', to: 'pair' },
      { ts: '2024-01-01T00:00:05Z', from: 'pair', to: 'default' },
    ]);
  });

  it('creates and updates tasks across task_created + task_updated', () => {
    const events = [
      { type: 'task_created', ts: '2024-01-01T00:00:00Z', taskId: 't1', title: 'one' } as any,
      { type: 'task_updated', ts: '2024-01-01T00:00:01Z', taskId: 't1', status: 'in_progress' } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0]).toMatchObject({ taskId: 't1', title: 'one', status: 'in_progress' });
  });

  it('marks tasks completed with completedAt when task_completed seen', () => {
    const events = [
      { type: 'task_created', ts: '2024-01-01T00:00:00Z', taskId: 't1', title: 'x' } as any,
      { type: 'task_completed', ts: '2024-01-01T00:00:05Z', taskId: 't1', title: 'x' } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.tasks[0]).toMatchObject({
      taskId: 't1',
      status: 'completed',
      completedAt: '2024-01-01T00:00:05Z',
    });
  });

  it('handles task_completed for a task that was never created (synthesizes the entry)', () => {
    const events = [
      { type: 'task_completed', ts: '2024-01-01T00:00:00Z', taskId: 't9', title: 'orphan' } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.tasks[0]).toMatchObject({ taskId: 't9', status: 'completed', title: 'orphan' });
    expect(r.tasks[0]?.completedAt).toBe('2024-01-01T00:00:00Z');
  });

  it('marks tasks failed with completedAt when task_failed seen', () => {
    const events = [
      { type: 'task_created', ts: '2024-01-01T00:00:00Z', taskId: 't1', title: 'x' } as any,
      { type: 'task_failed', ts: '2024-01-01T00:00:05Z', taskId: 't1', title: 'x' } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.tasks[0]).toMatchObject({
      taskId: 't1',
      status: 'failed',
      completedAt: '2024-01-01T00:00:05Z',
    });
  });

  it('synthesizes orphan task entries on task_failed too', () => {
    const events = [
      { type: 'task_failed', ts: '2024-01-01T00:00:00Z', taskId: 'orph', title: 'never-saw' } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.tasks[0]).toMatchObject({ taskId: 'orph', status: 'failed', title: 'never-saw' });
  });

  it('task_updated for an unknown taskId is silently ignored', () => {
    const events = [
      { type: 'task_updated', ts: '2024-01-01T00:00:00Z', taskId: 'ghost', status: 'gone' } as any,
    ];
    const r = analyzer.analyze(events);
    expect(r.tasks).toEqual([]);
  });
});
