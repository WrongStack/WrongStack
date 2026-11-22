/**
 * The board feed cuts task titles to 40 chars and tool path summaries to 240
 * (the summary is also written to the durable audit log). Both cuts were raw
 * `slice()` calls that split an emoji straddling the boundary into a lone high
 * surrogate. The shared truncate backs off the high surrogate.
 */
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { TaskGraph, TaskNode } from '@wrongstack/contracts/types/task-graph';
import { DefaultTaskStore } from '@wrongstack/core/tasking';
import { describe, expect, it } from 'vitest';
import { SddBoardProjector } from '../src/sdd-board-projector.js';
import { TaskTracker } from '../src/task-tracker.js';

function node(id: string, title: string): TaskNode {
  return {
    id,
    title,
    description: '',
    type: 'feature',
    priority: 'medium',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  };
}

function project(title: string, filePath: string) {
  const g: TaskGraph = {
    id: 'g1',
    specId: 's1',
    title: 'G',
    nodes: new Map([['a', node('a', title)]]),
    edges: [],
    rootNodes: ['a'],
    createdAt: 0,
    updatedAt: 0,
  };
  const tracker = new TaskTracker({ store: new DefaultTaskStore() });
  tracker.setGraph(g);
  const events = new EventBus();
  const proj = new SddBoardProjector({ runId: 'r1', graph: g, tracker, events });
  events.emit('sdd.task.started', { runId: 'r1', taskId: 'a', subagentId: 's', agentName: 'Ada' });
  events.emit('subagent.tool_executed', {
    subagentId: 's',
    taskId: 'a',
    runId: 'r1',
    agentName: 'Ada',
    name: 'read_file',
    input: { filePath },
    durationMs: 5,
    ok: true,
  });
  const snap = proj.snapshot();
  proj.dispose();
  return {
    started: snap.feed?.find((f) => f.kind === 'started')?.text ?? '',
    detail: snap.taskEvents?.['a']?.find((f) => f.kind === 'tool')?.detail ?? '',
  };
}

describe('SddBoardProjector truncation', () => {
  it('does not split a surrogate pair in a feed title or a tool path summary', () => {
    const out = project(
      `${'T'.repeat(38)}🚀 finish the onboarding wizard rollout`,
      `${'d'.repeat(238)}📁/notes.md`,
    );
    expect(out.started.isWellFormed()).toBe(true);
    expect(out.started.endsWith(` (${'T'.repeat(38)}…)`)).toBe(true);
    expect(out.detail.isWellFormed()).toBe(true);
    expect(out.detail).toBe(`${'d'.repeat(238)}…`);
  });

  it('keeps short values unchanged and cuts long plain values at the same length as before', () => {
    const short = project('Short title', 'src/app.ts');
    expect(short.started.endsWith(' (Short title)')).toBe(true);
    expect(short.detail).toBe('src/app.ts');
    const long = project('t'.repeat(80), `src/${'p'.repeat(400)}.ts`);
    expect(long.started.endsWith(` (${'t'.repeat(39)}…)`)).toBe(true);
    expect(long.detail).toHaveLength(240);
    expect(long.detail.endsWith('…')).toBe(true);
  });
});
