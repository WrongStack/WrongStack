import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_LIMIT, emptyEngineState, reduceEngine } from '../src/engine-state';
import { SessionActivity } from '../src/SessionActivity';
import { activityRows } from '../src/session-activity-model';

describe('session activity', () => {
  it('joins actual tool lifecycle frames, reasoning, retry and run results without mixing sessions', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 'one' },
    });
    for (const event of [
      { type: 'iteration.started', payload: { sessionId: 'one', index: 1 } },
      {
        type: 'tool.started',
        payload: {
          sessionId: 'one',
          id: 'tool-1',
          name: 'exec',
          input: { command: 'git', args: ['status', '--short'] },
          fileTargets: [{ filePath: 'src/app.ts', operation: 'read' }],
        },
      },
      {
        type: 'tool.progress',
        payload: { sessionId: 'one', id: 'tool-1', event: { text: 'Scanning repository' } },
      },
      {
        type: 'tool.executed',
        payload: {
          sessionId: 'one',
          id: 'tool-1',
          name: 'exec',
          ok: true,
          durationMs: 18,
          output: '{"status":"clean"}',
          outputBytes: 18,
          sage: ['Project convention'],
        },
      },
      { type: 'provider.thinking_delta', payload: { sessionId: 'one', text: 'Check ' } },
      { type: 'provider.thinking_delta', payload: { sessionId: 'one', text: 'the result.' } },
      {
        type: 'provider.retry',
        payload: {
          sessionId: 'one',
          providerId: 'local',
          attempt: 2,
          delayMs: 100,
          description: 'Temporary failure',
        },
      },
      {
        type: 'tool.executed',
        payload: { sessionId: 'other', id: 'foreign', name: 'secret', ok: false },
      },
      { type: 'run.result', payload: { sessionId: 'one', status: 'done' } },
    ])
      state = reduceEngine(state, event);
    const rows = activityRows(state.activity);
    expect(rows.find((row) => row.id === 'tool:0::tool-1')).toMatchObject({
      status: 'done',
      durationMs: 18,
      outputBytes: 18,
      progress: ['Scanning repository'],
      files: [{ path: 'src/app.ts', operation: 'read' }],
      sage: ['Project convention'],
    });
    expect(rows.find((row) => row.kind === 'reasoning')?.output).toBe('Check the result.');
    expect(rows.find((row) => row.kind === 'retry')).toMatchObject({
      title: 'local retry 2',
      durationMs: 100,
    });
    expect(rows.some((row) => row.title === 'Run completed')).toBe(true);
    expect(rows.some((row) => row.id.endsWith(':foreign'))).toBe(false);
    const html = renderToStaticMarkup(
      createElement(SessionActivity, { events: state.activity, onOpenFile: () => {} }),
    );
    for (const text of [
      'Run activity',
      'exec',
      'status',
      '--short',
      'Scanning repository',
      'src/app.ts',
      'Project convention',
      'Check the result.',
      'Temporary failure',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('&quot;status&quot;:');
  });
  it('keeps the activity replay bounded and labels failed tool results', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 'one' },
    });
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i++)
      state = reduceEngine(state, {
        type: 'provider.retry',
        payload: { sessionId: 'one', providerId: 'fixture', attempt: i },
      });
    state = reduceEngine(state, {
      type: 'tool.executed',
      payload: {
        sessionId: 'one',
        id: 'failed',
        name: 'exec',
        ok: false,
        output: 'Command refused',
      },
    });
    expect(state.activity).toHaveLength(ACTIVITY_LIMIT);
    expect(activityRows(state.activity).find((row) => row.id.endsWith(':failed'))).toMatchObject({
      status: 'failed',
      output: 'Command refused',
    });
  });
  it('keeps reused tool IDs separate across runs and agents', () => {
    const frames = [
      { type: 'tool.started', payload: { id: 'same', agentId: 'a', name: 'exec' } },
      { type: 'tool.executed', payload: { id: 'same', agentId: 'a', ok: true, output: 'first' } },
      { type: 'tool.started', payload: { id: 'same', agentId: 'b', name: 'exec' } },
      { type: 'tool.executed', payload: { id: 'same', agentId: 'b', ok: true, output: 'second' } },
      { type: 'run.result', payload: { status: 'done' } },
      {
        type: 'tool.executed',
        payload: { id: 'same', agentId: 'a', name: 'exec', ok: true, output: 'third' },
      },
    ];
    expect(
      activityRows(frames)
        .filter((row) => row.kind === 'tool')
        .map((row) => row.output),
    ).toEqual(['first', 'second', 'third']);
  });
  it('describes an iteration limit without fabricating a failed tool or run', () => {
    const rows = activityRows([{ type: 'run.result', payload: { status: 'max_iterations' } }]);
    expect(rows[0]).toMatchObject({ title: 'Iteration limit reached', status: 'info' });
  });
});
