import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/core/kernel/events.js';
import { DefaultTaskStore } from '@wrongstack/core/tasking';
import type { TaskGraph, TaskNode } from '@wrongstack/core/types/task-graph.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SddBoardProjector } from '../src/sdd-board-projector.js';
import { SddBoardStore } from '../src/sdd-board-store.js';
import { TaskTracker, type TaskTrackerChange } from '../src/task-tracker.js';

function node(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: id,
    description: '',
    type: 'feature',
    priority: 'medium',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function graph(): TaskGraph {
  return {
    id: 'g1',
    specId: 's1',
    title: 'G',
    nodes: new Map([
      ['a', node('a', { createdAt: 1 })],
      ['b', node('b', { createdAt: 2 })],
    ]),
    edges: [{ id: 'e1', from: 'a', to: 'b', type: 'depends_on' }],
    rootNodes: ['a'],
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeTracker(g: TaskGraph): TaskTracker {
  const t = new TaskTracker({ store: new DefaultTaskStore() });
  t.setGraph(g);
  return t;
}

describe('TaskTracker.subscribe', () => {
  it('fires status_changed with a transition', () => {
    const t = makeTracker(graph());
    const changes: TaskTrackerChange[] = [];
    t.subscribe((c) => changes.push(c));
    t.updateNodeStatus('a', 'in_progress');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe('status_changed');
    expect(changes[0]!.transition).toMatchObject({ from: 'pending', to: 'in_progress' });
  });

  it('fires node_updated on assignee change and unsubscribes cleanly', () => {
    const t = makeTracker(graph());
    const changes: TaskTrackerChange[] = [];
    const off = t.subscribe((c) => changes.push(c));
    t.updateNode('a', { assignee: 'Tesla' });
    expect(changes.at(-1)?.type).toBe('node_updated');
    off();
    t.updateNodeStatus('a', 'completed');
    expect(changes).toHaveLength(1); // no more after unsubscribe
  });

  it('a throwing listener never breaks the mutation', () => {
    const t = makeTracker(graph());
    t.subscribe(() => {
      throw new Error('boom');
    });
    expect(() => t.updateNodeStatus('a', 'completed')).not.toThrow();
    expect(t.getNode('a')?.status).toBe('completed');
  });
});

describe('SddBoardProjector', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-proj-'));
  const store = new SddBoardStore({ baseDir: dir });

  afterAll(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('builds a live snapshot from tracker state + run events', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const snapshots: Array<{ runId: string; snapshot: { status: string } }> = [];
    (events.on as (e: string, h: (p: unknown) => void) => void)('sdd.board.snapshot', (p) =>
      snapshots.push(p as { runId: string; snapshot: { status: string } }),
    );

    const proj = new SddBoardProjector({ runId: 'r1', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'r1', graphId: 'g1', specId: 's1', total: 2 });
    tracker.updateNodeStatus('a', 'completed');

    // On-demand snapshot reflects live tracker state.
    const live = proj.snapshot();
    expect(live.status).toBe('running');
    expect(live.progress.completed).toBe(1);
    expect(live.tasks.find((t) => t.id === 'b')?.displayStatus).toBe('queued');

    proj.dispose();
  });

  it('accumulates a live activity feed from task lifecycle events (most recent first)', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'rf', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'rf', graphId: 'g1', specId: 's1', total: 2 });
    events.emit('sdd.wave', { runId: 'rf', wave: 0, batchSize: 2 });
    events.emit('sdd.task.started', {
      runId: 'rf',
      taskId: 'a',
      subagentId: 's',
      agentName: 'Newton',
    });
    tracker.updateNodeStatus('a', 'completed');
    events.emit('sdd.task.completed', {
      runId: 'rf',
      taskId: 'a',
      subagentId: 's',
      durationMs: 2500,
    });

    const feed = proj.snapshot().feed ?? [];
    expect(feed.length).toBeGreaterThanOrEqual(3);
    expect(feed[0]?.kind).toBe('completed'); // newest first
    expect(feed.some((f) => f.kind === 'started' && f.agentName === 'Newton')).toBe(true);
    expect(feed.some((f) => f.kind === 'wave')).toBe(true);
    // Scoped by runId — a different run's event is ignored.
    events.emit('sdd.task.failed', { runId: 'OTHER', taskId: 'a', subagentId: 's', error: 'x' });
    expect(proj.snapshot().feed?.some((f) => f.kind === 'failed')).toBe(false);

    proj.dispose();
  });

  it('keeps task-scoped tool and file telemetry in a structured event log', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'audit', graph: g, tracker, events, store });

    events.emit('subagent.tool_executed', {
      subagentId: 'worker-1',
      taskId: 'a',
      runId: 'audit',
      agentName: 'Ada',
      name: 'shell_command',
      input: { command: 'pnpm test' },
      durationMs: 1200,
      ok: true,
    });
    events.emit('file.event', {
      operation: 'update',
      filePath: 'src/app.ts',
      absPath: '/project/src/app.ts',
      sessionId: 'session-1',
      agentId: 'worker-1',
      agentName: 'Ada',
      provider: 'openai',
      model: 'gpt-5',
      toolName: 'apply_patch',
      toolUseId: 'tool-1',
      scope: 'task',
      taskId: 'a',
      boardId: 'g1',
      runId: 'audit',
      timestamp: '2026-07-18T10:30:00.000Z',
    });

    const taskEvents = proj.snapshot().taskEvents?.['a'] ?? [];
    expect(taskEvents).toHaveLength(2);
    expect(taskEvents[0]).toMatchObject({
      kind: 'file',
      action: 'update',
      filePath: 'src/app.ts',
    });
    expect(taskEvents[1]).toMatchObject({
      kind: 'tool',
      action: 'shell_command',
      detail: '[command omitted]',
      durationMs: 1200,
      ok: true,
    });

    // A different graph's task must never leak into this board's audit trail.
    events.emit('subagent.tool_executed', {
      subagentId: 'worker-2',
      taskId: 'outside',
      runId: 'audit',
      name: 'read',
      durationMs: 1,
      ok: true,
    });
    expect(proj.snapshot().taskEvents?.['outside']).toBeUndefined();

    proj.dispose();
  });

  it('redacts and allowlists tool telemetry before snapshot and JSONL persistence', async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'sdd-proj-redact-'));
    const isolatedStore = new SddBoardStore({ baseDir: isolatedDir });
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({
      runId: 'redact',
      graph: g,
      tracker,
      events,
      store: isolatedStore,
    });
    const secret = 'MY_API_KEY=abcdef1234567890abcdef1234567890';
    const shortSecret = 'pwd=short-secret';

    events.emit('subagent.tool_executed', {
      subagentId: 'worker-1',
      taskId: 'a',
      runId: 'redact',
      agentName: 'Ada',
      name: 'bash',
      input: { command: `echo ${secret} ${shortSecret}`, password: 'must-not-persist' },
      output: `also-secret:${secret}`,
      durationMs: 10,
      ok: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const serializedSnapshot = JSON.stringify(proj.snapshot());
    const eventLog = await import('node:fs/promises').then((fs) =>
      fs.readFile(isolatedStore.eventsPath('redact'), 'utf8'),
    );
    expect(serializedSnapshot).not.toContain(secret);
    expect(serializedSnapshot).not.toContain(shortSecret);
    expect(serializedSnapshot).toContain('[command omitted]');
    expect(eventLog).not.toContain(secret);
    expect(eventLog).not.toContain(shortSecret);
    expect(eventLog).not.toContain('must-not-persist');
    expect(eventLog).not.toContain('"input"');
    expect(eventLog).not.toContain('"output"');
    expect(eventLog).toContain('[command omitted]');

    proj.dispose();
    await import('node:fs/promises').then((fs) =>
      fs.rm(isolatedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    );
  });

  it('rejects task telemetry correlated to a different run', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'mine', graph: g, tracker, events, store });

    events.emit('subagent.tool_executed', {
      subagentId: 'worker-1',
      taskId: 'a',
      runId: 'other',
      name: 'read',
      durationMs: 1,
      ok: true,
    });

    expect(proj.snapshot().taskEvents?.['a']).toBeUndefined();
    proj.dispose();
  });

  it('narrates the robustness events (verification / conflict / split / supervisor)', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'rr', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'rr', graphId: 'g1', specId: 's1', total: 2 });
    events.emit('sdd.task.verification_failed', {
      runId: 'rr',
      taskId: 'a',
      reason: 'tests failed',
    });
    events.emit('sdd.task.conflict', {
      runId: 'rr',
      taskId: 'a',
      conflictFiles: ['src/x.ts', 'src/y.ts'],
    });
    events.emit('sdd.task.split', { runId: 'rr', taskId: 'a', subtaskIds: ['a1', 'a2', 'a3'] });
    events.emit('sdd.supervisor.decision', {
      runId: 'rr',
      taskId: 'a',
      action: 'reassign',
      rationale: 'try a stronger model',
    });

    const feed = proj.snapshot().feed ?? [];
    const verify = feed.find((f) => f.kind === 'verification_failed');
    expect(verify?.text).toContain('tests failed');
    const conflict = feed.find((f) => f.kind === 'conflict');
    expect(conflict?.text).toContain('2 file(s)');
    expect(conflict?.text).toContain('src/x.ts');
    expect(feed.find((f) => f.kind === 'split')?.text).toContain('3 sub-task(s)');
    const sup = feed.find((f) => f.kind === 'supervisor');
    expect(sup?.text).toContain('reassign');
    expect(sup?.text).toContain('try a stronger model');

    // Scoped by runId — another run's robustness event is ignored.
    events.emit('sdd.task.split', { runId: 'OTHER', taskId: 'a', subtaskIds: ['z'] });
    expect(proj.snapshot().feed?.filter((f) => f.kind === 'split').length).toBe(1);

    proj.dispose();
  });

  it('finalizes + persists on run.finished', async () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'r2', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'r2', graphId: 'g1', specId: 's1', total: 2 });
    tracker.updateNodeStatus('a', 'completed');
    tracker.updateNodeStatus('b', 'completed');
    events.emit('sdd.run.finished', {
      runId: 'r2',
      deadlocked: false,
      completed: 2,
      failed: 0,
      stopped: false,
    });

    await proj.drain();
    const saved = await store.load('r2');
    expect(saved?.status).toBe('completed');
    expect(saved?.progress.completed).toBe(2);
    proj.dispose();
  });

  it('coalesces snapshots queued behind a slow disk write', async () => {
    const slowDir = mkdtempSync(join(tmpdir(), 'sdd-proj-slow-'));
    const slowStore = new SddBoardStore({ baseDir: slowDir });
    const saved: Array<{ wave: number }> = [];
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(slowStore, 'saveSnapshot').mockImplementation(async (snapshot) => {
      saved.push({ wave: snapshot.wave });
      if (saved.length === 1) await firstWrite;
    });
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({
      runId: 'slow',
      graph: g,
      tracker,
      events,
      store: slowStore,
      throttleMs: 0,
    });

    events.emit('sdd.run.started', { runId: 'slow', graphId: 'g1', specId: 's1', total: 2 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let wave = 1; wave <= 5; wave++) {
      events.emit('sdd.wave', { runId: 'slow', wave, batchSize: 1 });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(saved).toHaveLength(1);

    releaseFirst?.();
    await proj.drain();
    expect(saved).toHaveLength(2);
    expect(saved.at(-1)?.wave).toBe(5);
    proj.dispose();
    await import('node:fs/promises').then((fs) =>
      fs.rm(slowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    );
  });

  it('marks a user-stopped run as "stopped" (terminal, not the resumable "paused")', async () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'r-stop', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'r-stop', graphId: 'g1', specId: 's1', total: 2 });
    tracker.updateNodeStatus('a', 'completed'); // partial — b never ran
    events.emit('sdd.run.finished', {
      runId: 'r-stop',
      deadlocked: false,
      completed: 1,
      failed: 0,
      stopped: true,
    });

    await proj.drain();
    const saved = await store.load('r-stop');
    // Must be 'stopped' (inactive → lifecycle controls apply), NOT 'paused'.
    expect(saved?.status).toBe('stopped');
    proj.dispose();
  });

  it('marks deadlocked + records blocking chains (as short ids)', async () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'r3', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'r3', graphId: 'g1', specId: 's1', total: 2 });
    tracker.updateNodeStatus('a', 'failed');
    // b is blocked by failed a → deadlock chain
    events.emit('sdd.deadlock', { runId: 'r3', chains: [{ blocked: 'b', blockedBy: ['a'] }] });
    events.emit('sdd.run.finished', {
      runId: 'r3',
      deadlocked: true,
      completed: 0,
      failed: 1,
      stopped: false,
    });

    await proj.drain();
    const saved = await store.load('r3');
    expect(saved?.status).toBe('deadlocked');
    expect(saved?.diagnostics?.deadlockChains).toEqual([{ blocked: 't02', blockedBy: ['t01'] }]);
    proj.dispose();
  });

  it('ignores events for a different run id', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'r4', graph: g, tracker, events, store });
    events.emit('sdd.wave', { runId: 'OTHER', wave: 9, batchSize: 1 });
    expect(proj.snapshot().wave).toBe(0);
    proj.dispose();
  });

  it('summarizes every allowlisted tool-input shape and scrubs paths', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const scrubber = {
      scrub: (value: string) => value.replaceAll('SECRET', '[redacted]'),
    };
    const proj = new SddBoardProjector({
      runId: 'tools',
      graph: g,
      tracker,
      events,
      throttleMs: 10_000,
      secretScrubber: scrubber as never,
    });
    const inputs: unknown[] = [
      null,
      [],
      'text',
      { filePath: '  src/SECRET.ts  ' },
      { filePath: '   ', path: 'nested/file.ts' },
      { path: `SECRET/${'x'.repeat(260)}` },
      { cmd: 'secret command' },
      { query: 'secret query' },
      { pattern: 'secret pattern' },
      { other: true },
    ];

    for (const [index, input] of inputs.entries()) {
      events.emit('subagent.tool_executed', {
        subagentId: `worker-${index}`,
        taskId: 'a',
        runId: 'tools',
        agentName: index === 0 ? undefined : 'SECRET-agent',
        name: 'SECRET-tool',
        input,
        durationMs: index,
        ok: index % 2 === 0,
      });
    }

    const taskEvents = proj.snapshot().taskEvents?.['a'] ?? [];
    expect(taskEvents.some((entry) => entry.detail === 'src/[redacted].ts')).toBe(true);
    expect(taskEvents.some((entry) => entry.detail === 'nested/file.ts')).toBe(true);
    expect(taskEvents.some((entry) => entry.detail?.endsWith('…'))).toBe(true);
    expect(taskEvents.some((entry) => entry.detail === '[command omitted]')).toBe(true);
    expect(taskEvents.filter((entry) => entry.detail === '[query omitted]')).toHaveLength(2);
    expect(JSON.stringify(taskEvents)).not.toContain('SECRET');
    proj.dispose();
  });

  it('covers lifecycle narration fallbacks, merged commits, and failed completion', async () => {
    const g = graph();
    g.nodes.get('a')!.title = 'A'.repeat(50);
    g.nodes.get('a')!.assignee = 'Ada';
    g.nodes.get('b')!.title = '';
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({
      runId: 'edges',
      graph: g,
      tracker,
      events,
      store,
      baseBranch: 'option-base',
      defaultModel: 'model',
      defaultProvider: 'provider',
      fallbackModels: ['fallback'],
      now: () => 1234,
    });

    events.emit('sdd.run.started', {
      runId: 'edges',
      graphId: 'g1',
      specId: 's1',
      total: 2,
      baseBranch: 'event-base',
    });
    events.emit('sdd.task.started', {
      runId: 'edges',
      taskId: 'missing',
      subagentId: 'worker',
      agentName: '',
    });
    events.emit('sdd.task.failed', {
      runId: 'edges',
      taskId: 'missing',
      subagentId: 'worker',
      error: 'failed',
    });
    events.emit('sdd.task.completed', {
      runId: 'edges',
      taskId: 'a',
      subagentId: 'worker',
      durationMs: 100,
    });
    events.emit('sdd.task.completed', {
      runId: 'edges',
      taskId: 'missing',
      subagentId: 'worker',
      durationMs: 100,
    });
    events.emit('sdd.task.retrying', {
      runId: 'edges',
      taskId: 'missing',
      attempt: 2,
      maxRetries: 3,
    });
    events.emit('sdd.task.verification_failed', {
      runId: 'edges',
      taskId: 'missing',
      reason: 'verification failed',
    });
    events.emit('sdd.task.conflict', { runId: 'edges', taskId: 'b', conflictFiles: [] });
    events.emit('sdd.task.conflict', {
      runId: 'edges',
      taskId: 'missing',
      conflictFiles: ['missing.ts'],
    });
    events.emit('sdd.task.conflict', {
      runId: 'edges',
      taskId: 'a',
      conflictFiles: ['1.ts', '2.ts', '3.ts', '4.ts'],
    });
    events.emit('sdd.task.merged', { runId: 'edges', taskId: 'a', sha: 'abcdef012345' });
    events.emit('sdd.task.merged', { runId: 'edges', taskId: 'missing', sha: '1234567890' });
    events.emit('sdd.task.split', {
      runId: 'edges',
      taskId: 'missing',
      subtaskIds: [],
    });
    events.emit('sdd.supervisor.decision', {
      runId: 'edges',
      taskId: 'missing',
      action: 'fail',
    });
    events.emit('sdd.deadlock', {
      runId: 'edges',
      chains: [{ blocked: 'missing-blocked', blockedBy: ['missing-blocker'] }],
    });
    events.emit('sdd.run.finished', {
      runId: 'edges',
      deadlocked: false,
      completed: 0,
      failed: 1,
      stopped: false,
    });

    await proj.drain();
    const snap = proj.snapshot();
    expect(snap.status).toBe('failed');
    expect(snap.baseBranch).toBe('event-base');
    expect(snap.mergedCommits).toHaveLength(2);
    expect(snap.mergedCommits?.[1]?.title).toBe('');
    expect(snap.feed?.some((entry) => entry.text.includes('3.ts…'))).toBe(true);
    expect(snap.feed?.some((entry) => entry.text.includes('0 file(s)'))).toBe(true);
    proj.dispose();
  });

  it('uses option/default base labels and handles task/file telemetry edge cases', () => {
    const make = (runId: string, baseBranch?: string) => {
      const g = graph();
      const events = new EventBus();
      const proj = new SddBoardProjector({
        runId,
        graph: g,
        tracker: makeTracker(g),
        events,
        baseBranch,
      });
      return { events, proj };
    };
    const option = make('option', 'main');
    option.events.emit('sdd.task.merged', { runId: 'option', taskId: 'a', sha: 'abcdefgh' });
    expect(option.proj.snapshot().feed?.[0]?.text).toContain('main');

    const fallback = make('fallback');
    fallback.events.emit('sdd.task.merged', { runId: 'fallback', taskId: 'a', sha: 'abcdefgh' });
    expect(fallback.proj.snapshot().feed?.[0]?.text).toContain('base');

    fallback.events.emit('file.event', {
      operation: 'create',
      filePath: 'src/new.ts',
      absPath: '/src/new.ts',
      sessionId: 'session',
      agentId: 'worker',
      agentName: 'worker',
      provider: 'openai',
      model: 'model',
      toolName: 'write',
      toolUseId: 'tool',
      scope: 'global',
      timestamp: 'invalid',
      taskId: 'a',
      runId: 'fallback',
    });
    fallback.events.emit('file.event', {
      operation: 'create',
      filePath: 'src/new.ts',
      absPath: '/src/new.ts',
      sessionId: 'session',
      agentId: 'worker',
      agentName: 'worker',
      provider: 'openai',
      model: 'model',
      toolName: 'write',
      toolUseId: 'tool',
      scope: 'task',
      timestamp: 'invalid',
      taskId: 'a',
      runId: 'fallback',
    });
    expect(
      fallback.proj.snapshot().taskEvents?.['a']?.filter((entry) => entry.kind === 'file'),
    ).toHaveLength(1);
    option.proj.dispose();
    fallback.proj.dispose();
  });

  it('caps feed histories and omits empty session ids', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const snapshots: Array<{ sessionId?: string }> = [];
    (events.on as (event: string, handler: (payload: unknown) => void) => void)(
      'sdd.board.snapshot',
      (payload) => snapshots.push(payload as { sessionId?: string }),
    );
    const proj = new SddBoardProjector({
      runId: 'caps',
      graph: g,
      tracker,
      events,
      sessionId: () => '',
      throttleMs: 10_000,
    });
    for (let index = 0; index < 260; index++) {
      events.emit('sdd.task.retrying', {
        runId: 'caps',
        taskId: 'a',
        attempt: index,
        maxRetries: 300,
      });
    }
    events.emit('sdd.run.finished', {
      runId: 'caps',
      deadlocked: false,
      completed: 0,
      failed: 1,
      stopped: false,
    });

    expect(proj.snapshot().feed).toHaveLength(60);
    expect(proj.snapshot().taskEvents?.['a']).toHaveLength(250);
    expect(snapshots[0]).not.toHaveProperty('sessionId');
    proj.dispose();
  });

  it('emits static and function session ids and tolerates failed snapshot saves', async () => {
    for (const sessionId of ['static-session', () => 'function-session'] as const) {
      const g = graph();
      const tracker = makeTracker(g);
      const events = new EventBus();
      const seen: Array<string | undefined> = [];
      (events.on as (event: string, handler: (payload: unknown) => void) => void)(
        'sdd.board.snapshot',
        (payload) => seen.push((payload as { sessionId?: string }).sessionId),
      );
      const failingStore = new SddBoardStore({ baseDir: dir });
      vi.spyOn(failingStore, 'saveSnapshot').mockRejectedValue(new Error('disk failed'));
      const proj = new SddBoardProjector({
        runId: typeof sessionId === 'string' ? 'static' : 'function',
        graph: g,
        tracker,
        events,
        store: failingStore,
        sessionId,
      });
      events.emit('sdd.run.finished', {
        runId: typeof sessionId === 'string' ? 'static' : 'function',
        deadlocked: false,
        completed: 0,
        failed: 1,
        stopped: false,
      });
      await expect(proj.drain()).resolves.toBeUndefined();
      expect(seen).toEqual([typeof sessionId === 'string' ? sessionId : 'function-session']);
      proj.dispose();
    }
  });
});
